import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockButler, newMockState } from "../../../test/mock-server/butler-mock";
import { serveMcp, type ServedMcp } from "../../../test/support/http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientCredentialsTokens, McpClientManager } from "./client-manager";
import { isModelVisible } from "./tools";

let served: ServedMcp;
const mgr = new McpClientManager();

beforeAll(async () => {
  served = await serveMcp(() => createMockButler(newMockState()), { token: "tok" });
});
afterAll(async () => {
  await mgr.close();
  await served.close();
});

describe("McpClientManager", () => {
  it("reports an error status when the bearer token is wrong", async () => {
    const [info] = await mgr.configure([{ id: "bad", name: "Bad", url: served.url, auth: { type: "bearer", token: "nope" } }]);
    expect(info!.status).toBe("error");
    expect(info!.error).toBeTruthy();
    await mgr.disconnect("bad");
  });

  it("connects, negotiates a protocol version and lists tools incl. UI metadata", async () => {
    const [info] = await mgr.configure([{ id: "butler", name: "Butler", url: served.url, auth: { type: "bearer", token: "tok" }, invocationName: "Butler" }]);
    expect(info!.status).toBe("connected");
    expect(info!.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info!.serverInfo?.name).toBe("butler-mock");
    expect(info!.clientCapabilities).toMatchObject({ elicitation: { form: {}, url: {} }, extensions: { "io.modelcontextprotocol/ui": {} } });
    const names = info!.tools.map((t) => t.name);
    expect(names).toContain("handle_situation");
    const hs = info!.tools.find((t) => t.name === "handle_situation")!;
    expect(hs.uiResourceUri).toBe("ui://mock/plan");
    const getPlan = info!.tools.find((t) => t.name === "get_plan")!;
    expect(getPlan.visibility).toEqual(["app"]);
    expect(isModelVisible(getPlan)).toBe(false);
    expect(isModelVisible(hs)).toBe(true);
    expect(info!.resources.map((r) => r.uri)).toContain("ui://mock/plan");
  });

  it("calls a tool with timings and resolves the UI resource", async () => {
    const seen: string[] = [];
    mgr.onCall = (r) => seen.push(r.tool);
    const rec = await mgr.callTool("butler", "handle_situation", { situation: "six friends are coming over Friday at 7" });
    expect(rec.error).toBeUndefined();
    expect((rec.result!.structuredContent as { plan: { kind: string } }).plan.kind).toBe("hosting");
    expect(rec.uiResourceUri).toBe("ui://mock/plan");
    expect(rec.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(rec.timings.ttfbMs).not.toBeNull();
    expect(seen).toEqual(["handle_situation"]);
  });

  it("returns a CallRecord error for unknown servers instead of throwing", async () => {
    const rec = await mgr.callTool("ghost", "x", {});
    expect(rec.error).toMatch(/not connected/);
  });

  it("reads a ui:// resource once and serves later reads from cache", async () => {
    const a = await mgr.readUiResource("butler", "ui://mock/plan");
    expect(a.html).toContain("<script>");
    expect(a.cached).toBeUndefined();
    const b = await mgr.readUiResource("butler", "ui://mock/plan");
    expect(b.cached).toBe(true);
  });
});

describe("OAuth2 client credentials", () => {
  it("fetches a token with basic auth, caches it, refreshes on expiry, and the manager sends it as a bearer", async () => {
    let issued = 0;
    const tokenServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const basic = Buffer.from(String(req.headers.authorization).replace("Basic ", ""), "base64").toString();
        if (basic !== "cid:csecret" || !body.includes("grant_type=client_credentials")) return res.writeHead(401).end();
        issued++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `tok-${issued}`, expires_in: 60 }));
      });
    });
    await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
    const tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/oauth2/token`;

    const t = new ClientCredentialsTokens({ tokenUrl, clientId: "cid", clientSecret: "csecret", scope: "x/y" });
    expect(await t.get(1_000)).toBe("tok-1");
    expect(await t.get(2_000)).toBe("tok-1"); // cached
    expect(await t.get(1_000 + 40_000)).toBe("tok-2"); // within 30 s of expiry -> refreshed
    await expect(new ClientCredentialsTokens({ tokenUrl, clientId: "cid", clientSecret: "bad" }).get()).rejects.toThrow(/401/);

    const protectedServer = await serveMcp(() => createMockButler(newMockState()), { token: "tok-3" });
    const m = new McpClientManager();
    const [info] = await m.configure([{ id: "p", name: "P", url: protectedServer.url, auth: { type: "client_credentials", tokenUrl, clientId: "cid", clientSecret: "csecret" } }]);
    expect(info!.status).toBe("connected"); // issued tok-3 on first request
    expect(issued).toBe(3);
    await m.close();
    await protectedServer.close();
    await new Promise<void>((r) => tokenServer.close(() => r()));
  });
});
