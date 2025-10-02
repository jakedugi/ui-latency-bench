import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import waitOn from "wait-on";

const work = path.join(process.cwd(), "work");
fs.mkdirSync(work, { recursive: true });

const repos = [
  { name: "custom-next-langchain", url: process.env.REPO_CUSTOM!, port: 3000, start: "npm run dev" },
  { name: "copilotkit-ui", url: process.env.REPO_COPILOT!, port: 3001, start: "npm run dev" },
  { name: "agent-chat-ui-langgraph", url: process.env.REPO_AGENT!, port: 3002, start: "npm run dev" }
].filter(r => r.url);

async function sh(cmd: string, cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, { cwd, shell: true, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  for (const r of repos) {
    const dir = path.join(work, r.name);
    if (!fs.existsSync(dir)) {
      await sh(`git clone ${r.url} ${dir}`, work);
    }
    await sh(`npm ci || npm i`, dir);
    sh(r.start, dir); // run in background
  }

  await waitOn({ resources: repos.map(r => `http://localhost:${r.port}`), timeout: 120000 });
  console.log("All targets are up.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
