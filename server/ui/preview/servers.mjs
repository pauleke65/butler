// Starts (if not already running) the fixture MCP server on :8001 and the preview dev server on :5180.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = resolve(uiRoot, "..");

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(800) })).status > 0;
  } catch {
    return false;
  }
}

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not start`);
}

/** Returns a stop() function that only stops what this call started. */
export async function ensureServers({ fixturePort = 8001, previewPort = 5180 } = {}) {
  const children = [];
  if (!(await up(`http://127.0.0.1:${fixturePort}/__fixtures/ids`))) {
    children.push(spawn("pnpm", ["exec", "tsx", "src/dev/fixtureServer.ts"], { cwd: serverRoot, env: { ...process.env, PORT: String(fixturePort) }, stdio: "inherit" }));
    await waitFor(`http://127.0.0.1:${fixturePort}/__fixtures/ids`, "fixture server");
  }
  if (!(await up(`http://127.0.0.1:${previewPort}/`))) {
    children.push(spawn("pnpm", ["exec", "vite", "--config", "preview/vite.config.ts", "--port", String(previewPort), "--host", "127.0.0.1", "--strictPort"], { cwd: uiRoot, stdio: "inherit" }));
    await waitFor(`http://127.0.0.1:${previewPort}/`, "preview server");
  }
  return () => children.forEach((c) => c.kill());
}
