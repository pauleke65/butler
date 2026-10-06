import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SIM_CLIENT_INFO, UI_EXTENSION_ID, UI_MIME_TYPE } from "./constants";
import { getUiResourceUri, getVisibility, resolveUiResourceUri } from "./tools";
import type {
  CallRecord,
  ConnectionInfo,
  ElicitationHandler,
  ResourceInfo,
  ServerConfig,
  ToolInfo,
  ToolResult,
  UiResourcePayload,
  JsonSchema,
} from "./types";

/** Fetches and caches OAuth2 client-credentials access tokens (refreshed 30 s before expiry). */
export class ClientCredentialsTokens {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly cfg: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async get(now = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > now) return this.cached.token;
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.cfg.scope) body.set("scope", this.cfg.scope);
    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`token request failed (${res.status}) at ${this.cfg.tokenUrl}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("token response had no access_token");
    this.cached = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }
}

interface Connection {
  config: ServerConfig;
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  info: ConnectionInfo;
  tokens?: ClientCredentialsTokens;
}

interface CallContext {
  /** Set by the fetch wrapper when POST response headers for tools/call arrive. */
  headersAt?: number;
  elicit?: ElicitationHandler;
  server: string;
}

const callContext = new AsyncLocalStorage<CallContext>();

/** What this simulator tells servers it supports. Shown in the inspector. */
export const CLIENT_CAPABILITIES = {
  elicitation: { form: {}, url: {} },
  extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } },
} as const;

export interface CallOptions {
  origin?: CallRecord["origin"];
  elicit?: ElicitationHandler;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpClientManager {
  private conns = new Map<string, Connection>();
  private resourceCache = new Map<string, UiResourcePayload>();
  private callSeq = 0;
  /** Used when a call has no per-call elicitation handler. */
  defaultElicit?: ElicitationHandler;
  /** Called for every completed (or failed) call; the API layer streams these to the inspector. */
  onCall?: (rec: CallRecord) => void;

  /** Replace the configured servers. Keeps existing healthy connections whose config is unchanged. */
  async configure(servers: ServerConfig[]): Promise<ConnectionInfo[]> {
    const wanted = new Map(servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));
    for (const [id, c] of this.conns) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(c.config) || c.info.status !== "connected") {
        await this.disconnect(id);
      }
    }
    await Promise.all(
      [...wanted.values()].map(async (cfg) => {
        if (this.conns.has(cfg.id)) return;
        await this.connect(cfg);
      }),
    );
    return this.list();
  }

  list(): ConnectionInfo[] {
    return [...this.conns.values()].map((c) => c.info);
  }

  get(id: string): ConnectionInfo | undefined {
    return this.conns.get(id)?.info;
  }

  allTools(): ToolInfo[] {
    return this.list().flatMap((c) => (c.status === "connected" ? c.tools : []));
  }

  findTool(server: string, name: string): ToolInfo | undefined {
    return this.conns.get(server)?.info.tools.find((t) => t.name === name);
  }

  async connect(config: ServerConfig): Promise<ConnectionInfo> {
    const info: ConnectionInfo = {
      id: config.id,
      name: config.name,
      url: config.url,
      status: "connecting",
      tools: [],
      resources: [],
      clientCapabilities: CLIENT_CAPABILITIES as unknown as Record<string, unknown>,
    };
    const conn: Connection = { config, info };
    this.conns.set(config.id, conn);
    const t0 = Date.now();
    try {
      if (config.auth.type === "client_credentials") conn.tokens = new ClientCredentialsTokens(config.auth);
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: this.timedFetch(config, conn),
      });
      const client = new Client(SIM_CLIENT_INFO, {
        capabilities: CLIENT_CAPABILITIES as never,
      });
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const handler = callContext.getStore()?.elicit ?? this.defaultElicit;
        const params = request.params as Record<string, unknown>;
        if (!handler) return { action: "decline" as const };
        const mode = params.mode === "url" ? "url" : "form";
        const res = await handler({
          id: `elic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          server: config.id,
          mode,
          message: String(params.message ?? ""),
          requestedSchema: params.requestedSchema as JsonSchema | undefined,
          url: typeof params.url === "string" ? params.url : undefined,
          elicitationId: typeof params.elicitationId === "string" ? params.elicitationId : undefined,
        });
        return res as never;
      });
      client.onclose = () => {
        if (conn.info.status === "connected") conn.info.status = "idle";
      };
      await client.connect(transport);
      conn.client = client;
      conn.transport = transport;
      info.protocolVersion = transport.protocolVersion;
      const v = client.getServerVersion();
      info.serverInfo = v ? { name: v.name, version: v.version } : undefined;
      info.serverCapabilities = (client.getServerCapabilities() ?? {}) as Record<string, unknown>;
      info.instructions = client.getInstructions();
      await this.refresh(conn);
      info.status = "connected";
      info.connectedAt = new Date().toISOString();
      info.connectMs = Date.now() - t0;
    } catch (err) {
      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
    }
    return info;
  }

  /** Re-list tools and resources (also used after a `tools/list_changed`). */
  private async refresh(conn: Connection): Promise<void> {
    const client = conn.client!;
    const caps = client.getServerCapabilities() ?? {};
    const tools: ToolInfo[] = [];
    if (caps.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          const meta = (t as { _meta?: Record<string, unknown> })._meta;
          tools.push({
            server: conn.config.id,
            name: t.name,
            title: t.title,
            description: t.description ?? "",
            inputSchema: (t.inputSchema ?? { type: "object" }) as JsonSchema,
            meta,
            uiResourceUri: getUiResourceUri(meta),
            visibility: getVisibility(meta),
            annotations: t.annotations as Record<string, unknown> | undefined,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const resources: ResourceInfo[] = [];
    if (caps.resources) {
      try {
        const page = await client.listResources();
        for (const r of page.resources) {
          resources.push({ server: conn.config.id, uri: r.uri, name: r.name, mimeType: r.mimeType, description: r.description });
        }
      } catch {
        /* resource listing is optional */
      }
    }
    conn.info.tools = tools;
    conn.info.resources = resources;
  }

  async disconnect(id: string): Promise<void> {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (c?.client) {
      try {
        await c.client.close();
      } catch {
        /* ignore */
      }
    }
    for (const k of [...this.resourceCache.keys()]) if (k.startsWith(`${id}|`)) this.resourceCache.delete(k);
  }

  async close(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  /** fetch wrapper that stamps the time response headers arrive for the in-flight tools/call. */
  private timedFetch(config: ServerConfig, conn: Connection): typeof fetch {
    const server = config.id;
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      if (config.auth.type === "bearer" && config.auth.token) headers.set("Authorization", `Bearer ${config.auth.token}`);
      else if (conn.tokens) headers.set("Authorization", `Bearer ${await conn.tokens.get()}`);
      const res = await fetch(input, { ...init, headers });
      if (res.status === 401) conn.tokens?.invalidate();
      const ctx = callContext.getStore();
      if (ctx && ctx.server === server && init?.method === "POST" && ctx.headersAt === undefined) {
        const body = typeof init.body === "string" ? init.body : "";
        if (body.includes('"tools/call"')) ctx.headersAt = performance.now();
      }
      return res;
    };
  }

  /** Errors that mean "the session is gone" (server restarted, session expired): reconnect and retry once. */
  private static isStaleSession(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number }).code;
    return code === 404 || code === 401 || /session|not connected|connection closed|fetch failed|ECONNREFUSED|ECONNRESET|unauthorized/i.test(msg);
  }

  async callTool(server: string, name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallRecord> {
    const rec = await this.callToolOnce(server, name, args, opts);
    const conn = this.conns.get(server);
    if (rec.error && conn && McpClientManager.isStaleSession(rec.error)) {
      const info = await this.reconnect(server);
      if (info?.status === "connected") return this.callToolOnce(server, name, args, opts);
    }
    return rec;
  }

  /** Drop and re-establish one connection (new session, fresh tool list). */
  async reconnect(server: string): Promise<ConnectionInfo | undefined> {
    const cfg = this.conns.get(server)?.config;
    if (!cfg) return undefined;
    await this.disconnect(server);
    return this.connect(cfg);
  }

  private async callToolOnce(server: string, name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallRecord> {
    const conn = this.conns.get(server);
    const id = `call_${++this.callSeq}`;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const ctx: CallContext = { server, elicit: opts.elicit };
    const tool = conn?.info.tools.find((t) => t.name === name);
    const rec: CallRecord = {
      id,
      server,
      tool: name,
      args,
      origin: opts.origin ?? "brain",
      timings: { startedAt, ttfbMs: null, totalMs: 0 },
    };
    try {
      if (!conn?.client || conn.info.status !== "connected") throw new Error(`Server "${server}" is not connected`);
      const client = conn.client;
      const result = (await callContext.run(ctx, () =>
        client.callTool({ name, arguments: args }, undefined, {
          signal: opts.signal,
          timeout: opts.timeoutMs ?? 120_000,
          resetTimeoutOnProgress: true,
        }),
      )) as unknown as ToolResult;
      rec.result = result;
      rec.uiResourceUri = resolveUiResourceUri(tool, result);
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
    }
    const t1 = performance.now();
    rec.timings.totalMs = Math.round(t1 - t0);
    rec.timings.ttfbMs = ctx.headersAt !== undefined ? Math.round(ctx.headersAt - t0) : null;
    this.onCall?.(rec);
    return rec;
  }

  /** Fetch a ui:// resource once and cache it for the session (invalidate with `clearResourceCache`). */
  async readUiResource(server: string, uri: string): Promise<UiResourcePayload> {
    try {
      return await this.readUiResourceOnce(server, uri);
    } catch (err) {
      if (!McpClientManager.isStaleSession(err)) throw err;
      const info = await this.reconnect(server);
      if (info?.status !== "connected") throw err;
      return this.readUiResourceOnce(server, uri);
    }
  }

  private async readUiResourceOnce(server: string, uri: string): Promise<UiResourcePayload> {
    const key = `${server}|${uri}`;
    const hit = this.resourceCache.get(key);
    if (hit) return { ...hit, cached: true, fetchMs: 0 };
    const conn = this.conns.get(server);
    if (!conn?.client) throw new Error(`Server "${server}" is not connected`);
    const t0 = performance.now();
    const res = await conn.client.readResource({ uri });
    const content = res.contents[0] as
      | { uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }
      | undefined;
    if (!content) throw new Error(`Resource ${uri} returned no contents`);
    const html = typeof content.text === "string" ? content.text : content.blob ? Buffer.from(content.blob, "base64").toString("utf8") : "";
    if (!html) throw new Error(`Resource ${uri} has no text/blob`);
    const listing = conn.info.resources.find((r) => r.uri === uri);
    void listing;
    const ui = (content._meta?.ui ?? (res as { _meta?: Record<string, unknown> })._meta?.ui) as
      | { csp?: Record<string, unknown>; permissions?: Record<string, unknown> }
      | undefined;
    const payload: UiResourcePayload = {
      uri,
      html,
      mimeType: content.mimeType,
      csp: ui?.csp,
      permissions: ui?.permissions,
      fetchMs: Math.round(performance.now() - t0),
    };
    this.resourceCache.set(key, payload);
    return payload;
  }

  clearResourceCache(): void {
    this.resourceCache.clear();
  }
}
