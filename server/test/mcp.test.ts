/** MCP-level tests: the real SDK client against the real Streamable HTTP server on a loopback port. */
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";
import { VIEW_NAMES, VIEW_URI } from "../src/lib/views.js";
import { TOOLS } from "../src/tools/index.js";
import { lintSpoken } from "../src/lib/lintSpoken.js";
import { fixtures, makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let http: HttpServer;
let base: string;

beforeAll(async () => {
  env = await makeEnv();
  http = createHttpApp(env.deps);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
});

async function connect(headers: Record<string, string> = {}): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

describe("initialize and protocol negotiation", () => {
  it("negotiates 2025-11-25 and identifies as butler 0.1.0", async () => {
    const { client, transport } = await connect();
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(transport.protocolVersion).toBe("2025-11-25");
    expect(client.getServerVersion()).toMatchObject({ name: "butler", version: "0.1.0", title: "Butler" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    expect(client.getInstructions()).toContain("handle_situation");
    await client.close();
  });

  it("accepts older protocol versions (what Alexa+ sends today: 2025-03-26) and replies with the same version", async () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(expect.arrayContaining(["2025-11-25", "2025-06-18", "2025-03-26"]));
    for (const version of ["2025-03-26", "2025-06-18"]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "alexa-like", version: "1" } },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
      expect(body.result.protocolVersion).toBe(version);
      expect(body.result.serverInfo.name).toBe("butler");
    }
  });

  it("falls back to the latest version for an unknown one", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });
});

describe("tools/list", () => {
  it("lists the nine tools plus the two app-only helpers with schemas, annotations, icons and _meta.ui", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "handle_situation", "get_status", "answer_decision", "list_actions", "explain_action",
      "object_to_action", "list_rules", "change_rule", "undo_action", "get_ledger_page", "get_plan",
    ]);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect((t.outputSchema as { oneOf?: unknown[] }).oneOf, t.name).toHaveLength(2);
      expect(t.annotations, t.name).toBeDefined();
      expect(t.icons?.[0]?.src, t.name).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(t.icons?.[0]?.sizes).toEqual(["64x64"]);
      const ui = (t._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui;
      expect(ui, t.name).toBeDefined();
      if (ui?.visibility) {
        expect(ui.visibility).toEqual(["app"]);
        expect(["get_ledger_page", "get_plan"]).toContain(t.name);
      } else {
        expect(Object.values(VIEW_URI)).toContain(ui?.resourceUri);
        expect((t._meta as Record<string, unknown>)["ui/resourceUri"]).toBe(ui?.resourceUri);
        expect(t.description, t.name).toMatch(/^Use when /);
        expect(t.description, t.name).toMatch(/[Rr]eturns /);
      }
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["handle_situation"]?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(byName["get_status"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["answer_decision"]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName["undo_action"]?.annotations?.destructiveHint).toBe(true);
    expect((byName["handle_situation"]?.inputSchema.properties as Record<string, { description?: string; minLength?: number }>)["situation"]).toMatchObject({ minLength: 3 });
    expect(byName["handle_situation"]?.inputSchema.required).toEqual(["situation"]);
    expect(byName["get_status"]?._meta).toMatchObject({ ui: { resourceUri: "ui://butler/plan" } });
    await client.close();
  });
});

describe("resources", () => {
  it("lists the six ui:// views and reads each as text/html;profile=mcp-app", async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(VIEW_NAMES.map((v) => VIEW_URI[v]).sort());
    for (const r of resources) expect(r.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    for (const v of VIEW_NAMES) {
      const res = await client.readResource({ uri: VIEW_URI[v] });
      const c = res.contents[0] as { uri: string; mimeType: string; text: string };
      expect(c.uri).toBe(VIEW_URI[v]);
      expect(c.mimeType).toBe("text/html;profile=mcp-app");
      expect(c.text.toLowerCase()).toContain("<html");
    }
    await client.close();
  });

  it("unknown resources are protocol errors", async () => {
    const { client } = await connect();
    await expect(client.readResource({ uri: "ui://butler/nope" })).rejects.toThrow();
    await client.close();
  });
});

describe("tools/call envelope", () => {
  it("handle_situation over the wire: structuredContent + text JSON + _meta.ui, validated by the client against outputSchema", async () => {
    const { client } = await connect({ authorization: "Bearer local-sim-token" });
    await client.listTools(); // lets the client cache output validators
    const res = await client.callTool({ name: "handle_situation", arguments: { situation: "Six friends from the dinner crew are coming over Friday at 7." } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { ok: boolean; spoken_summary: string; plan: { kind: string } };
    expect(sc.ok).toBe(true);
    expect(sc.plan.kind).toBe("hosting");
    expect(lintSpoken(sc.spoken_summary)).toEqual([]);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(sc);
    expect(res._meta).toEqual({ ui: { resourceUri: "ui://butler/plan", invoking: "Working on it…", invoked: "Here's the plan" } });
    await env.settle();
    await client.close();
  });

  it("every model-visible read tool answers with a valid envelope", async () => {
    const { client } = await connect();
    await client.listTools();
    for (const [name, args] of [
      ["get_status", {}],
      ["list_actions", {}],
      ["list_rules", {}],
      ["explain_action", { action_id: fixtures.receipts[0]!.action_id }],
      ["get_plan", { plan_id: fixtures.planHosting.plan_id }],
      ["get_ledger_page", { limit: 2 }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
      expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    }
    await client.close();
  });

  it("invalid input comes back as an INVALID_INPUT tool error, not a protocol error", async () => {
    const { client } = await connect();
    await client.listTools();
    const res = await client.callTool({ name: "handle_situation", arguments: { situation: "hi" } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { ok: boolean; error: { code: string; message_spoken: string; details?: string } };
    expect(sc.ok).toBe(false);
    expect(sc.error.code).toBe("INVALID_INPUT");
    expect(sc.error.details).toContain("situation");
    await client.close();
  });

  it("an unknown tool does not crash the server", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "nope", arguments: {} }).catch((e: unknown) => e);
    expect(res).toBeDefined();
    const ok = await client.callTool({ name: "list_rules", arguments: {} });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });
});

describe("HTTP behaviour", () => {
  it("GET /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "butler", version: "0.1.0" });
  });

  it("is stateless: no session id is issued and each request stands alone", async () => {
    const { transport, client } = await connect();
    expect(transport.sessionId).toBeUndefined();
    // a second, independent client works without any shared state
    const other = await connect();
    expect((await other.client.listTools()).tools).toHaveLength(TOOLS.length);
    await client.close();
    await other.client.close();
  });

  it("GET/DELETE /mcp are 405, unknown paths 404, bad JSON 400, CORS preflight 204", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    const pre = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects an unrecognised bearer token with 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer not-a-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("resolves the household from the token (HOUSEHOLD_BY_SUB)", async () => {
    const other = await makeEnv({ seed: false });
    other.deps.config.householdBySub = { "*": "hh_demo", "special-sub": "hh_other" };
    other.deps.config.stage = "demo";
    await other.repo.putPlan({ ...fixtures.planHosting, household_id: "hh_other", title: "Other household plan" });
    const server = createHttpApp(other.deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const jwt = `x.${Buffer.from(JSON.stringify({ sub: "special-sub" })).toString("base64url")}.y`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${jwt}` } } });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.callTool({ name: "get_status", arguments: {} });
    expect((res.structuredContent as { plan: { title: string } }).plan.title).toBe("Other household plan");
    await client.close();
    // no token at all is rejected outside the local stage
    const anon = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(anon.status).toBe(401);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
