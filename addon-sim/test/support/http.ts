import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface ServedMcp {
  url: string;
  port: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Serve an MCP server over stateless Streamable HTTP at `/mcp` (one server + transport per request,
 * the same shape AgentCore Runtime expects). Optionally require a bearer token.
 */
export async function serveMcp(
  make: () => McpServer,
  opts: { port?: number; token?: string; log?: (line: string) => void; stateful?: boolean } = {},
): Promise<ServedMcp> {
  // Stateful mode keeps one server + transport per session (needed for server -> client requests such as elicitation,
  // because the server only learns the client's capabilities from `initialize`).
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (opts.stateful) {
      try {
        const sid = req.headers["mcp-session-id"] as string | undefined;
        const body = req.method === "POST" ? await readBody(req) : undefined;
        let entry = sid ? sessions.get(sid) : undefined;
        if (!entry) {
          if (req.method !== "POST" || (body as { method?: string } | undefined)?.method !== "initialize") {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }));
            return;
          }
          const server = make();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, server });
            },
          });
          await server.connect(transport);
          entry = { transport, server };
        }
        opts.log?.(`${(body as { method?: string })?.method ?? req.method}`);
        await entry.transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null }));
      }
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
      const body = await readBody(req);
      opts.log?.(`${(body as { method?: string })?.method ?? "?"}`);
      const server = make();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null }));
    }
  });
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.();
        http.close(() => resolve());
      }),
  };
}
