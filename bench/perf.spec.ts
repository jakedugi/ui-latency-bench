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

async function runPrompt(page: any, sel: Target["selectors"], text: string) {
  await page.locator(sel.input).fill(text);
  await page.locator(sel.send).click();
  await page.locator(sel.assistant).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(120); // allow render_ms capture
  const samples = await page.evaluate(() => (window as any).__perf?.samples ?? []);
  return samples as any[];
}

function summarize(samples: any[], label = "chat") {
  const val = (name: string) =>
    samples.findLast((s: any) => s.metric === `${label}:${name}`)?.value ??
    samples.findLast((s: any) => s.metric === name)?.value;

  return {
    ttfb_ms: Math.round(val("ttfb_ms") ?? -1),
    ttft_ms: Math.round(val("ttft_ms") ?? -1),
    ttl_ms: Math.round(val("ttl_ms") ?? -1),
    render_ms: Math.round(val("render_ms") ?? -1),
    bytes_total: Math.round(val("bytes_total") ?? -1),
  };
}

for (const target of targets) {
  test.describe(`UI Latency Standard v1: ${target.name}`, () => {
    test(`P1: Simple query (first token latency)`, async ({ page, context }) => {
      const perfInit = fs.readFileSync(path.join(__dirname, "perf-init.js"), "utf8");
      await page.addInitScript(perfInit);
      await page.addInitScript(({ fetchRegex }) => {
        (window as any).__installFetchPerf?.(fetchRegex);
      }, { fetchRegex: target.fetchRegex });

      await page.goto(target.baseUrl, { waitUntil: "domcontentloaded" });
      await set4G(context, page);

      const samples = await runPrompt(page, target.selectors, `Show me Mohamed Salah`);
      const m = summarize(samples);

      expect(m.ttfb_ms).toBeLessThan(1500);
      expect(m.ttft_ms).toBeLessThan(1800);
      expect(m.render_ms).toBeLessThan(150);

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT_DIR, `${target.name}-P1.json`), JSON.stringify(m, null, 2));
    });

    test(`P2: Complex query (streaming throughput)`, async ({ page, context }) => {
      const perfInit = fs.readFileSync(path.join(__dirname, "perf-init.js"), "utf8");
      await page.addInitScript(perfInit);
      await page.addInitScript(({ fetchRegex }) => {
        (window as any).__installFetchPerf?.(fetchRegex);
      }, { fetchRegex: target.fetchRegex });

      await page.goto(target.baseUrl, { waitUntil: "domcontentloaded" });
      await set4G(context, page);

      const samples = await runPrompt(
        page,
        target.selectors,
        `Show me Mohamed Salah's goals and assists in 2025`
      );
      const m = summarize(samples);

      expect(m.ttfb_ms).toBeLessThan(2000);
      expect(m.ttft_ms).toBeLessThan(2200);
      expect(m.ttl_ms).toBeLessThan(6000);
      expect(m.bytes_total).toBeGreaterThan(400);

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT_DIR, `${target.name}-P2.json`), JSON.stringify(m, null, 2));
    });
  });
}

test.afterAll(async () => {
  // Aggregate here if desired; CI also calls scripts/aggregate.ts
});
