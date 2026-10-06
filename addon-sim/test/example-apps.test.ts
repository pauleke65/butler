import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfflineBrain } from "../src/lib/brain/offline";
import { runScript } from "../src/lib/runner/runner";
import { parseScript } from "../src/lib/runner/script";
import { McpClientManager } from "../src/lib/mcp/client-manager";
import { LocalDriver, autoElicit } from "../src/lib/runner/local-driver";
import { createExampleServer } from "./example-apps-server/server";
import { serveMcp, type ServedMcp } from "./support/http";

let served: ServedMcp;
const mgr = new McpClientManager();

beforeAll(async () => {
  const state = { count: 0 };
  // stateful: elicitation needs the session's negotiated client capabilities
  served = await serveMcp(() => createExampleServer(state), { stateful: true });
  await mgr.configure([{ id: "ex", name: "Example", url: served.url, auth: { type: "none" } }]);
});
afterAll(async () => {
  await mgr.close();
  await served.close();
});

describe("example MCP Apps server (public-example shape)", () => {
  it("takes the UI resource from the tool definition when the result has no _meta", async () => {
    const rec = await mgr.callTool("ex", "show_counter", {});
    expect(rec.result?._meta).toBeUndefined();
    expect(rec.uiResourceUri).toBe("ui://example/counter");
    const res = await mgr.readUiResource("ex", "ui://example/counter");
    expect(res.html).toContain("data-testid");
  });

  it("view-initiated tool call works and the app-only tool is hidden from the model", async () => {
    const info = mgr.get("ex")!;
    expect(info.tools.find((t) => t.name === "increment")!.visibility).toEqual(["app"]);
    const rec = await mgr.callTool("ex", "increment", { by: 2 }, { origin: "view" });
    expect((rec.result!.structuredContent as { count: number }).count).toBe(2);
  });

  it("round-trips a form elicitation through the client", async () => {
    const asked: string[] = [];
    const rec = await mgr.callTool("ex", "buy_coffee", {}, {
      elicit: async (req) => {
        asked.push(`${req.mode}:${req.message}`);
        return autoElicit("accept-defaults")(req);
      },
    });
    expect(asked).toEqual(["form:Should I order a coffee for 4 dollars?"]);
    expect((rec.result!.structuredContent as { ordered: boolean }).ordered).toBe(true);
  });

  it("reconnects transparently when the server restarted and the session is gone", async () => {
    const port = served.port;
    await served.close();
    served = await serveMcp(() => createExampleServer({ count: 40 }), { port, stateful: true }); // new process: old session id is unknown
    const rec = await mgr.callTool("ex", "increment", { by: 2 });
    expect(rec.error).toBeUndefined();
    expect((rec.result!.structuredContent as { count: number }).count).toBe(42);
  });

  it("declines elicitation and supports url mode", async () => {
    const declined = await mgr.callTool("ex", "buy_coffee", {}, { elicit: autoElicit("decline") });
    expect((declined.result!.structuredContent as { ordered: boolean }).ordered).toBe(false);
    let url = "";
    const rec = await mgr.callTool("ex", "pay_online", {}, { elicit: async (r) => { url = r.url ?? ""; return { action: "accept" }; } });
    expect(url).toBe("https://example.com/approve?invoice=demo");
    expect((rec.result!.structuredContent as { action: string }).action).toBe("accept");
  });

  it("runs scripts/example-apps.yaml headless (brain + elicitation auto-answer)", async () => {
    const fresh = await serveMcp(() => createExampleServer({ count: 0 }), { stateful: true });
    const m = new McpClientManager();
    m.defaultElicit = autoElicit("accept-defaults");
    await m.configure([{ id: "example", name: "Example", url: fresh.url, auth: { type: "none" } }]);
    const driver = new LocalDriver(m, new OfflineBrain(), "example");
    const report = await runScript(parseScript(readFileSync("scripts/example-apps.yaml", "utf8")), driver);
    const failures = report.results.filter((r) => r.status === "fail").map((r) => `${r.label}: ${r.details.join(" | ")}`);
    await m.close();
    await fresh.close();
    expect(failures).toEqual([]);
  });
});
