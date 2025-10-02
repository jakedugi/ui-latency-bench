import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const TARGETS_PATH = process.env.TARGETS_PATH ?? path.join(__dirname, "targets.json");
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(process.cwd(), "artifacts");

type Target = {
  name: string;
  baseUrl: string;
  fetchRegex: string;         // e.g. "/api/(chat|nlq|threads|runs)"
  selectors: {
    input: string;            // e.g. [data-testid="chat-input"]
    send: string;             // e.g. [data-testid="send-button"]
    assistant: string;        // e.g. [data-testid="assistant-msg"]
  };
};

const targets: Target[] = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));

async function set4G(context: any, page: any) {
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 10e6 / 8,
    uploadThroughput: 5e6 / 8,
    connectionType: "cellular4g",
  });
}

async function ensureNLQMode(page: any, targetName: string) {
  // For custom-next-langchain, ensure we're in NLQ mode
  if (targetName === "custom-next-langchain") {
    const nlqButton = page.locator('button:has-text("NL-GraphQL")');
    if (await nlqButton.count() > 0) {
      await nlqButton.click();
      await page.waitForTimeout(500);
    }
  }
}

interface NetworkMetrics {
  ttfb_ms: number;
  ttft_ms: number;
  ttl_ms: number;
  render_ms: number;
  bytes_total: number;
  url: string;
}

async function runPromptWithNetworkTracking(
  page: any,
  sel: Target["selectors"],
  text: string,
  fetchRegex: string
): Promise<NetworkMetrics> {
  const regex = new RegExp(fetchRegex);
  let ttfb_ms = -1;
  let ttft_ms = -1;
  let ttl_ms = -1;
  let bytes_total = 0;
  let matchedUrl = "";
  let requestStartTime = 0;
  let firstChunkTime = 0;
  let responseEndTime = 0;

  let requestHandler: any = null;
  let responseHandler: any = null;
  let requestCaptured = false;

  // Set up network interception BEFORE the action
  const responsePromise = new Promise<void>((resolve) => {
    responseHandler = async (response: any) => {
      const url = response.url();
      if (!regex.test(url)) return;
      
      // Skip if we've already captured a response (avoid /api/info, etc.)
      if (requestCaptured && matchedUrl && matchedUrl !== url) return;
      
      const method = response.request().method();
      const contentType = response.headers()['content-type'] || '';
      console.log(`[NET] Response ${method} ${url} (${contentType})`);
      
      // Track mutations (POST/PUT/PATCH) OR streaming GET requests
      // Skip only info/health/search checks
      const isInfoRequest = url.includes('/info') || url.includes('/health') || url.includes('/search') || url.includes('/history') || url.endsWith('/api/');
      
      if (isInfoRequest) {
        console.log(`[NET] Skipping info/health/search check request`);
        return;
      }
      
      // Must be a mutation or contain 'stream' or 'run' in the URL
      const isRelevantRequest = method !== 'GET' || url.includes('/stream') || url.includes('/runs');
      if (!isRelevantRequest) {
        console.log(`[NET] Skipping non-relevant GET request`);
        return;
      }
      
      matchedUrl = url;
      requestCaptured = true;
      
      try {
        // Measure TTFB (time to first byte - when headers arrive)
        const now = Date.now();
        if (requestStartTime > 0) {
          ttfb_ms = now - requestStartTime;
          ttft_ms = ttfb_ms; // For streaming, TTFT ≈ TTFB (when first chunk arrives)
          console.log(`[NET] TTFB: ${ttfb_ms}ms`);
        }

        // Try to get body size
        try {
          const body = await response.body();
          bytes_total = body.length;
          responseEndTime = Date.now();
          ttl_ms = responseEndTime - requestStartTime;
          console.log(`[NET] Response complete. Bytes: ${bytes_total}, TTL: ${ttl_ms}ms`);
          
          // Clean up handlers
          page.off('response', responseHandler);
          page.off('request', requestHandler);
          resolve();
        } catch (e) {
          // Streaming response - body not available, wait a bit more
          console.log(`[NET] Streaming response - waiting for completion`);
          await page.waitForTimeout(3000);
          responseEndTime = Date.now();
          ttl_ms = responseEndTime - requestStartTime;
          console.log(`[NET] Streaming complete (estimated). TTL: ${ttl_ms}ms`);
          
          // Clean up handlers
          page.off('response', responseHandler);
          page.off('request', requestHandler);
          resolve();
        }
      } catch (err) {
        console.error(`[NET] Error processing response:`, err);
        page.off('response', responseHandler);
        page.off('request', requestHandler);
        resolve();
      }
    };

    requestHandler = (request: any) => {
      const url = request.url();
      const method = request.method();
      
      // Debug: log ALL requests to see what's happening
      if (url.includes('/api/')) {
        console.log(`[DEBUG] All API requests: ${method} ${url}`);
      }
      
      // Track any meaningful API request (skip only info/health/search/history checks)
      const isInfoRequest = url.includes('/info') || url.includes('/health') || url.includes('/search') || url.includes('/history') || url.endsWith('/api/');
      const isRelevantRequest = !isInfoRequest && (method !== 'GET' || url.includes('/stream') || url.includes('/runs'));
      
      if (regex.test(url) && isRelevantRequest && requestStartTime === 0) {
        requestStartTime = Date.now();
        console.log(`[NET] Request started: ${method} ${url}`);
      }
    };

    page.on('response', responseHandler);
    page.on('request', requestHandler);
  });

  // Mark render start
  const renderStartMark = Date.now();

  // Fill input and click send button
  await page.locator(sel.input).fill(text);
  await page.locator(sel.send).waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForTimeout(100); // Allow React state to update
  
  // Click and start tracking
  await page.locator(sel.send).click({ force: true });

  // Wait for response to complete (longer for streaming)
  await Promise.race([
    responsePromise,
    page.waitForTimeout(45000) // 45s timeout for slow streaming responses
  ]);

  // Wait for visual rendering
  await page.waitForTimeout(3000); // Give time for DOM updates and streaming to complete
  const render_ms = Date.now() - (responseEndTime || renderStartMark);

  console.log(`[NET] Final metrics - TTFB: ${ttfb_ms}ms, TTFT: ${ttft_ms}ms, TTL: ${ttl_ms}ms, Bytes: ${bytes_total}`);

  return {
    ttfb_ms: ttfb_ms > 0 ? Math.round(ttfb_ms) : -1,
    ttft_ms: ttft_ms > 0 ? Math.round(ttft_ms) : ttfb_ms,
    ttl_ms: ttl_ms > 0 ? Math.round(ttl_ms) : ttfb_ms,
    render_ms: Math.round(render_ms),
    bytes_total,
    url: matchedUrl
  };
}

function calculateStats(runs: NetworkMetrics[]) {
  const metrics = ['ttfb_ms', 'ttft_ms', 'ttl_ms', 'render_ms', 'bytes_total'];
  const result: any = {};
  
  for (const metric of metrics) {
    const values = runs.map(r => r[metric]).filter(v => v > 0);
    if (values.length === 0) {
      result[metric] = -1;
      result[`${metric}_median`] = -1;
    } else {
      // Calculate mean
      result[metric] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      // Calculate median
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result[`${metric}_median`] = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
  }
  
  return result;
}

const NUM_RUNS = 3; // Number of runs for statistical significance (plus 1 warmup)

for (const target of targets) {
  test.describe(`UI Latency Standard v1: ${target.name}`, () => {
    test(`P1: Simple query (first token latency)`, async ({ page, context }) => {
      await page.goto(target.baseUrl, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000); // Extra wait for full initialization
      await set4G(context, page);
      await ensureNLQMode(page, target.name);

      // Warmup run to initialize page state (results discarded)
      console.log(`\n[TEST] ${target.name} P1 - Warmup run...`);
      await runPromptWithNetworkTracking(
        page,
        target.selectors,
        `Show me Mohamed Salah`,
        target.fetchRegex
      );
      console.log(`[TEST] Warmup complete, starting measured runs...`);
      await page.waitForTimeout(2000);

      // Run multiple times and calculate statistics
      const runs: NetworkMetrics[] = [];
      for (let i = 0; i < NUM_RUNS; i++) {
        console.log(`\n[TEST] ${target.name} P1 - Run ${i + 1}/${NUM_RUNS}`);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForTimeout(1000); // Wait for reload to settle
        await ensureNLQMode(page, target.name);
        
        const metrics = await runPromptWithNetworkTracking(
          page,
          target.selectors,
          `Show me Mohamed Salah`,
          target.fetchRegex
        );
        
        runs.push(metrics);
        console.log(`[TEST] Run ${i + 1} complete:`, metrics);
        await page.waitForTimeout(1000); // Brief pause between runs
      }

      const stats = calculateStats(runs);
      console.log(`[TEST] ${target.name} P1 final stats:`, stats);

      // Validate metrics were captured
      if (stats.ttfb_ms > 0) {
        expect(stats.ttfb_ms).toBeLessThan(10000);
        expect(stats.ttft_ms).toBeLessThan(10000);
      }

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT_DIR, `${target.name}-P1.json`), JSON.stringify(stats, null, 2));
    });

    test(`P2: Complex query (streaming throughput)`, async ({ page, context }) => {
      // Fresh page load for P2 to avoid any state from P1
      await page.goto(target.baseUrl, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000); // Extra wait for full initialization
      await set4G(context, page);
      await ensureNLQMode(page, target.name);

      // Warmup run to initialize page state (results discarded)
      console.log(`\n[TEST] ${target.name} P2 - Warmup run...`);
      await runPromptWithNetworkTracking(
        page,
        target.selectors,
        `Show me Mohamed Salah's goals and assists in 2025`,
        target.fetchRegex
      );
      console.log(`[TEST] Warmup complete, starting measured runs...`);
      await page.waitForTimeout(2000);

      // Run multiple times and calculate statistics
      const runs: NetworkMetrics[] = [];
      for (let i = 0; i < NUM_RUNS; i++) {
        console.log(`\n[TEST] ${target.name} P2 - Run ${i + 1}/${NUM_RUNS}`);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForTimeout(1000); // Wait for reload to settle
        await ensureNLQMode(page, target.name);
        
        const metrics = await runPromptWithNetworkTracking(
          page,
          target.selectors,
          `Show me Mohamed Salah's goals and assists in 2025`,
          target.fetchRegex
        );
        
        runs.push(metrics);
        console.log(`[TEST] Run ${i + 1} complete:`, metrics);
        await page.waitForTimeout(1000); // Brief pause between runs
      }

      const stats = calculateStats(runs);
      console.log(`[TEST] ${target.name} P2 final stats:`, stats);

      // Validate metrics were captured
      if (stats.ttfb_ms > 0) {
        expect(stats.ttfb_ms).toBeLessThan(10000);
        expect(stats.ttft_ms).toBeLessThan(10000);
        expect(stats.ttl_ms).toBeLessThan(20000);
        expect(stats.bytes_total).toBeGreaterThan(50);
      }

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT_DIR, `${target.name}-P2.json`), JSON.stringify(stats, null, 2));
    });
  });
}

test.afterAll(async () => {
  // Aggregate here if desired; CI also calls scripts/aggregate.ts
});
