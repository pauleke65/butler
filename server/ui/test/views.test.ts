import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIEWS = ["plan", "options", "receipt", "actions", "rule", "rules"];

beforeAll(() => {
  if (VIEWS.some((v) => !existsSync(resolve(root, `dist/${v}.html`)))) execFileSync("node", ["build.mjs"], { cwd: root, stdio: "ignore" });
}, 120_000);

describe("built views", () => {
  for (const v of VIEWS) {
    it(`${v}.html is one self-contained file under 200 KB`, () => {
      const file = resolve(root, `dist/${v}.html`);
      expect(statSync(file).size).toBeLessThan(200 * 1024);
      const html = readFileSync(file, "utf8");
      expect(html).not.toMatch(/<script[^>]+\ssrc=/i);
      expect(html).not.toMatch(/<link[^>]+href=["']?(https?:)?\/\//i);
      expect(html).not.toMatch(/(src|href)=["']https?:\/\//i);
      expect(html).toContain("--fs-base"); // tokens inlined
      expect(html).toContain("ui/initialize"); // bridge inlined
    });
  }
});

describe("MiniApp wire protocol", () => {
  it("handshakes, delivers tool results to handlers registered before connect, and answers teardown/ping", async () => {
    const sent: any[] = [];
    const listeners = new Set<(e: any) => void>();
    const parent = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
    vi.stubGlobal("window", { addEventListener: (_: string, l: (e: any) => void) => listeners.add(l), removeEventListener: (_: string, l: (e: any) => void) => listeners.delete(l), parent: {}, innerWidth: 1280 });
    const { MiniApp } = await import("../src/bridge");
    const app = new MiniApp({ name: "t", version: "1" }, { parent, autoResize: false });
    const deliver = (data: unknown) => listeners.forEach((l) => l({ source: parent, data }));

    const results: unknown[] = [];
    let torn = false;
    app.ontoolresult = (r) => results.push(r);
    app.onteardown = () => { torn = true; };
    const ctxs: unknown[] = [];
    app.onhostcontextchanged = (c) => ctxs.push(c);

    const connected = app.connect();
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "t" } } });
    deliver({ jsonrpc: "2.0", id: sent[0].id, result: { protocolVersion: "2026-01-26", hostContext: { theme: "light" }, hostCapabilities: {} } });
    await connected;
    expect(sent[1]).toMatchObject({ method: "ui/notifications/initialized" });
    expect(ctxs).toEqual([{ theme: "light" }]);

    deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { ok: true } } });
    expect(results).toEqual([{ structuredContent: { ok: true } }]);

    const call = app.callServerTool({ name: "get_status", arguments: { plan_id: "p" } });
    const req = sent[sent.length - 1];
    expect(req).toMatchObject({ method: "tools/call", params: { name: "get_status", arguments: { plan_id: "p" } } });
    deliver({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true, x: 1 } } });
    expect(await call).toEqual({ structuredContent: { ok: true, x: 1 } });

    const mode = app.requestDisplayMode("fullscreen");
    deliver({ jsonrpc: "2.0", id: sent[sent.length - 1].id, result: { mode: "fullscreen" } });
    expect(await mode).toBe("fullscreen");

    const failing = app.callServerTool({ name: "x" });
    deliver({ jsonrpc: "2.0", id: sent[sent.length - 1].id, error: { code: -32000, message: "nope" } });
    await expect(failing).rejects.toThrow("nope");

    deliver({ jsonrpc: "2.0", id: 99, method: "ping" });
    expect(sent[sent.length - 1]).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
    deliver({ jsonrpc: "2.0", id: 100, method: "ui/resource-teardown", params: {} });
    await Promise.resolve();
    expect(torn).toBe(true);
    // messages from other windows are ignored
    listeners.forEach((l) => l({ source: {}, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { evil: 1 } } } }));
    expect(results).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
