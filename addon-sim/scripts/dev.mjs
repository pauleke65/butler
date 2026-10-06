#!/usr/bin/env node
// Starts the simulator host (Next.js, :3000) and the sandbox proxy (:3001) together.
import { spawn } from "node:child_process";

const prod = process.argv.includes("--prod");
const hostPort = process.env.PORT || "3000";
const children = [
  spawn("npx", ["tsx", "sandbox/server.ts"], { stdio: "inherit", env: process.env }),
  spawn("npx", ["next", prod ? "start" : "dev", "-p", hostPort], { stdio: "inherit", env: process.env }),
];
const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { stop(); process.exit(code ?? 0); });
