import fs from "fs";
import path from "path";

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(process.cwd(), "artifacts");
const files = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR) : [];

type Metric = {
  ttfb_ms: number;
  ttft_ms: number;
  ttl_ms: number;
  render_ms: number;
  bytes_total: number;
};

const rows: { name: string; p1?: Metric; p2?: Metric }[] = [];

for (const f of files) {
  if (!f.endsWith(".json")) continue;
  const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), "utf8"));
  const [name, test] = f.replace(".json", "").split("-P");
  let row = rows.find(r => r.name === name);
  if (!row) {
    row = { name };
    rows.push(row);
  }
  if (test === "1") row.p1 = data;
  if (test === "2") row.p2 = data;
}

let md = `# UI Latency Bench Results\n\n`;
md += `| UI | P1 ttfb | P1 ttft | P1 render | P2 ttfb | P2 ttft | P2 ttl | P2 render | P2 bytes |\n`;
md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of rows) {
  const p1 = r.p1 ?? {};
  const p2 = r.p2 ?? {};
  md += `| ${r.name} | ${p1.ttfb_ms ?? ""} | ${p1.ttft_ms ?? ""} | ${p1.render_ms ?? ""} | ${p2.ttfb_ms ?? ""} | ${p2.ttft_ms ?? ""} | ${p2.ttl_ms ?? ""} | ${p2.render_ms ?? ""} | ${p2.bytes_total ?? ""} |\n`;
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "results.json"), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, "results.md"), md);
console.log(md);
