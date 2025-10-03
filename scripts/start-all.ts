import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import waitOn from "wait-on";

const work = path.join(process.cwd(), "work");
fs.mkdirSync(work, { recursive: true });

const repos = [
  {
    name: "custom-next-langchain",
    url: process.env.REPO_CUSTOM!,
    services: [{ port: 3000, start: "npm run dev", name: "ui" }],
  },
  {
    name: "copilotkit-ui",
    url: process.env.REPO_COPILOT!,
    services: [{ port: 3001, start: "npm run dev", name: "ui" }],
  },
  {
    name: "agent-chat-ui-langgraph",
    url: process.env.REPO_AGENT!,
    services: [
      { port: 3002, start: "npm run dev", name: "frontend" },
      { port: 8000, start: "npm run start:server", name: "backend" },
    ],
  },
].filter((r) => r.url);

async function sh(cmd: string, cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, { cwd, shell: true, stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

async function main() {
  const allServices: { repo: string; port: number; name: string }[] = [];

  for (const r of repos) {
    const dir = path.join(work, r.name);
    if (!fs.existsSync(dir)) {
      console.log(`Cloning ${r.name}...`);
      await sh(`git clone ${r.url} ${dir}`, work);
    }
    console.log(`Installing dependencies for ${r.name}...`);
    await sh(`npm ci || npm i`, dir);

    // Start each service for this repository
    for (const service of r.services) {
      console.log(
        `Starting ${r.name}/${service.name} on port ${service.port}...`,
      );
      sh(service.start, dir); // run in background
      allServices.push({
        repo: r.name,
        port: service.port,
        name: service.name,
      });
    }
  }

  console.log("Waiting for all services to start...");
  const resources = allServices.map((s) => `http://localhost:${s.port}`);
  await waitOn({ resources, timeout: 120000 });
  console.log("All services are up:");
  allServices.forEach((s) =>
    console.log(`  ${s.repo}/${s.name}: http://localhost:${s.port}`),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
