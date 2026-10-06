/**
 * Minimal MCP Apps view bridge.
 *
 * Why not `App` from @modelcontextprotocol/ext-apps? Importing it pulls the whole MCP SDK type schema plus
 * zod into the bundle (about 445 KB minified), which breaks the < 200 KB per view budget. This class speaks the
 * same wire protocol (JSON-RPC 2.0 over window.postMessage, `ui/initialize` handshake) with the same method names
 * (`ontoolresult`, `onhostcontextchanged`, `onteardown`, `callServerTool`, `requestDisplayMode`, `sendMessage`)
 * and the same rule: register handlers BEFORE `connect()`. The preview page runs the real ext-apps `AppBridge`
 * (host side) against it, so protocol drift shows up as a failing preview.
 */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export const UI_PROTOCOL_VERSION = "2026-01-26";

export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export type HostContext = McpUiHostContext;

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class MiniApp {
  ontoolinput?: (params: { arguments?: Record<string, unknown> }) => void;
  ontoolresult?: (result: ToolResult) => void;
  ontoolcancelled?: (params: { reason?: string }) => void;
  onhostcontextchanged?: (ctx: HostContext) => void;
  onteardown?: () => void | Promise<void>;

  private hostContext: HostContext = {};
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private connected = false;
  private readonly parent: Window;

  constructor(
    private readonly info: { name: string; version: string },
    private readonly opts: { autoResize?: boolean; parent?: Window } = {},
  ) {
    this.parent = opts.parent ?? window.parent;
  }

  getHostContext(): HostContext {
    return this.hostContext;
  }

  get isEmbedded(): boolean {
    return this.parent !== window;
  }

  async connect(): Promise<void> {
    if (this.connected) throw new Error("already connected");
    window.addEventListener("message", this.onMessage);
    const res = (await this.request("ui/initialize", {
      appInfo: this.info,
      appCapabilities: {},
      protocolVersion: UI_PROTOCOL_VERSION,
    })) as { hostContext?: HostContext } | undefined;
    this.hostContext = res?.hostContext ?? {};
    this.connected = true;
    this.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    this.onhostcontextchanged?.(this.hostContext);
    if (this.opts.autoResize !== false) this.watchSize();
  }

  callServerTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult> {
    return this.request("tools/call", params, 60_000) as Promise<ToolResult>;
  }

  async requestDisplayMode(mode: "inline" | "fullscreen" | "pip"): Promise<string> {
    const res = (await this.request("ui/request-display-mode", { mode })) as { mode?: string } | undefined;
    return res?.mode ?? "inline";
  }

  async sendMessage(text: string): Promise<void> {
    await this.request("ui/message", { role: "user", content: [{ type: "text", text }] });
  }

  close(): void {
    window.removeEventListener("message", this.onMessage);
    this.connected = false;
  }

  // ───────── internals ─────────

  private send(msg: RpcMessage): void {
    this.parent.postMessage(msg, "*");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.parent) return;
    const msg = event.data as RpcMessage | undefined;
    if (!msg || msg.jsonrpc !== "2.0") return;

    if (msg.method !== undefined) {
      if (msg.id !== undefined) void this.onRequest(msg);
      else this.onNotification(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };

  private async onRequest(msg: RpcMessage): Promise<void> {
    const id = msg.id as number | string;
    try {
      if (msg.method === "ping") return this.send({ jsonrpc: "2.0", id, result: {} });
      if (msg.method === "ui/resource-teardown") {
        await this.onteardown?.();
        return this.send({ jsonrpc: "2.0", id, result: {} });
      }
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    } catch (e) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : "error" } });
    }
  }

  private onNotification(msg: RpcMessage): void {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "ui/notifications/tool-result":
        this.ontoolresult?.(p as ToolResult);
        break;
      case "ui/notifications/tool-input":
        this.ontoolinput?.(p as { arguments?: Record<string, unknown> });
        break;
      case "ui/notifications/tool-cancelled":
        this.ontoolcancelled?.(p as { reason?: string });
        break;
      case "ui/notifications/host-context-changed":
        this.hostContext = { ...this.hostContext, ...(p as HostContext) };
        this.onhostcontextchanged?.(p as HostContext);
        break;
      default:
        break;
    }
  }

  private watchSize(): void {
    let scheduled = false;
    let lastW = 0;
    let lastH = 0;
    const measure = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const el = document.documentElement;
        const prev = el.style.height;
        el.style.height = "max-content";
        const h = Math.ceil(el.getBoundingClientRect().height);
        el.style.height = prev;
        const w = Math.ceil(window.innerWidth);
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          this.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: w, height: h } });
        }
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }
}
