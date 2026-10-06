/**
 * Streamable HTTP entry (contracts §3.1). STATELESS: a fresh McpServer + transport per request, nothing kept
 * between requests, so it scales horizontally and survives AgentCore Runtime restarts.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Deps } from "./deps.js";
import { authenticate } from "./lib/auth.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text);
}

function corsHeaders(deps: Deps, req: IncomingMessage): Record<string, string> {
  const origin = deps.config.corsOrigin ?? (deps.config.stage === "local" ? "*" : undefined);
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": String(
      req.headers["access-control-request-headers"] ?? "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, x-correlation-id",
    ),
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  };
}

export function createHandler(deps: Deps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cors = corsHeaders(deps, req);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
        sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, stage: deps.config.stage });
        return;
      }

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const auth = authenticate(req.headers.authorization, deps.config);
      if (!auth.ok) {
        deps.logger.log("warn", "http.unauthorized", { reason: auth.reason });
        sendJson(res, 401, jsonRpcError(-32001, `Unauthorized: ${auth.reason}`), { "www-authenticate": 'Bearer realm="butler"' });
        return;
      }

      if (req.method !== "POST") {
        // Stateless server: no standalone SSE stream and no sessions to delete.
        sendJson(res, 405, jsonRpcError(-32000, "Method not allowed."), { allow: "POST" });
        return;
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        sendJson(res, 400, jsonRpcError(-32700, `Parse error: ${e instanceof Error ? e.message : "invalid body"}`));
        return;
      }

      const correlation = req.headers["x-correlation-id"];
      const server = createServer(deps, {
        householdId: auth.principal.householdId,
        correlationId: typeof correlation === "string" ? correlation : undefined,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: deps.config.jsonResponse,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      deps.logger.log("error", "http.unhandled", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
    }
  };
}

export function createHttpApp(deps: Deps): HttpServer {
  return createHttpServer((req, res) => {
    void createHandler(deps)(req, res);
  });
}
