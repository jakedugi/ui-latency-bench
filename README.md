# UI Latency Bench

Benchmark multiple chat UIs with standardized performance tests.

## Quick Start

1. Install dependencies:

```bash
npm install
npx playwright install
```

2. Configure targets:

```bash
cp bench/targets.example.json bench/targets.json
# Edit bench/targets.json with your UI URLs and selectors
```

3. Start your UIs on the configured ports

4. Run benchmarks:

```bash
npm run bench
```

Results appear in `artifacts/` as JSON and Markdown table.

## Metrics Measured

- **ttfb_ms**: Click → first byte
- **ttft_ms**: Click → first visible token
- **ttl_ms**: Click → last byte (stream end)
- **render_ms**: Stream end → next paint
- **bytes_total**: Streamed bytes

## CI Setup

Set these GitHub secrets:

- `REPO_CUSTOM`: Git URL to your custom Next.js UI
- `REPO_COPILOT`: Git URL to your CopilotKit UI
- `REPO_AGENT`: Git URL to your Agent Chat UI

Trigger the "UI Bench" workflow for automated comparison.
