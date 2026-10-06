/**
 * Browser-side MCP Apps host for ONE view: loads the sandbox proxy iframe (different origin), wires an
 * AppBridge to it, forwards the view's tools/call to the right MCP server (through our API), and delivers
 * tool input and then tool result. Follows MCP Apps spec 2026-01-26 ("Lifecycle", "Sandbox proxy").
 */
import { AppBridge, PostMessageTransport, type McpUiHostContext, type McpUiResourcePermissions, type McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema, UiResourcePayload } from "../mcp/types";
import { sandboxUrl } from "./csp";

export const HOST_INFO = { name: "addon-sim", version: "0.1.0" } as const;
const FIRST_RENDER_METHOD = "ui/notifications/sandbox-first-render";

/** Style variables (MCP Apps host styling), dark theme by default. */
export const DARK_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "#0b1220",
  "--color-background-secondary": "#111a2e",
  "--color-background-tertiary": "#18233d",
  "--color-text-primary": "#f1f5f9",
  "--color-text-secondary": "#cbd5e1",
  "--color-text-tertiary": "#94a3b8",
  "--color-border-primary": "#2a3856",
  "--color-ring-primary": "#38bdf8",
  "--font-sans": "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
  "--border-radius-md": "12px",
  "--border-radius-lg": "18px",
};

export interface ViewMetrics {
  /** sandbox iframe created -> view sent `initialized` */
  initMs?: number;
  /** tool result handed to the view -> first DOM change painted in the view */
  firstRenderMs?: number;
  firstRenderSource?: "proxy" | "sizechange";
  resourceCached?: boolean;
  resourceMs?: number;
}

export interface ViewHandlers {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
  readResource?(params: { uri: string }): Promise<ReadResourceResult>;
  /** Return the mode actually granted. */
  requestDisplayMode(mode: "inline" | "fullscreen" | "pip"): "inline" | "fullscreen";
  onSize?(size: { width?: number; height?: number }): void;
  onMetrics?(m: ViewMetrics): void;
  onMessage?(params: unknown): void;
  onOpenLink?(url: string): void;
  onLog?(params: unknown): void;
  onModelContext?(params: unknown): void;
  onError?(err: Error): void;
  onInitialized?(): void;
}

export interface ViewHostInit {
  iframe: HTMLIFrameElement;
  sandboxOrigin: string;
  resource: UiResourcePayload;
  tool?: { name: string; description?: string; inputSchema?: JsonSchema; _meta?: Record<string, unknown> };
  input: Record<string, unknown>;
  hostContext: McpUiHostContext;
  handlers: ViewHandlers;
}

export class ViewHost {
  readonly bridge: AppBridge;
  private metrics: ViewMetrics = {};
  private t0 = 0;
  private resultSentAt = 0;
  private firstSizeAfterResult = false;
  private msgListener?: (e: MessageEvent) => void;
  private closed = false;
  private ctx: McpUiHostContext;

  constructor(private readonly init: ViewHostInit) {
    this.ctx = { ...init.hostContext };
    const h = init.handlers;
    this.bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        updateModelContext: { text: {} },
        message: { text: {} },
        sandbox: init.resource.csp ? { csp: init.resource.csp as McpUiResourceCsp } : undefined,
      },
      { hostContext: init.hostContext },
    );
    // Register every handler before connect(): the view may send requests right after initialize.
    this.bridge.oncalltool = async (params) => h.callTool({ name: params.name, arguments: params.arguments as Record<string, unknown> | undefined });
    if (h.readResource) this.bridge.onreadresource = async (params) => h.readResource!(params);
    this.bridge.onlistresources = async () => ({ resources: [] });
    this.bridge.onrequestdisplaymode = async (params) => ({ mode: h.requestDisplayMode(params.mode) });
    this.bridge.onsizechange = (size) => {
      h.onSize?.(size);
      if (this.resultSentAt && !this.firstSizeAfterResult) {
        this.firstSizeAfterResult = true;
        // Fallback for sandboxes that cannot observe paint: size-changed after the result.
        window.setTimeout(() => {
          if (this.metrics.firstRenderMs === undefined) this.report({ firstRenderMs: Math.round(performance.now() - this.resultSentAt), firstRenderSource: "sizechange" });
        }, 250);
      }
    };
    this.bridge.onmessage = async (params) => {
      h.onMessage?.(params);
      return {};
    };
    this.bridge.onopenlink = async (params) => {
      h.onOpenLink?.(params.url);
      return {};
    };
    this.bridge.onloggingmessage = (params) => h.onLog?.(params);
    this.bridge.onupdatemodelcontext = async (params) => {
      h.onModelContext?.(params);
      return {};
    };
    this.bridge.onrequestteardown = () => h.onError?.(new Error("view requested teardown"));
  }

  private report(partial: ViewMetrics): void {
    this.metrics = { ...this.metrics, ...partial };
    this.init.handlers.onMetrics?.(this.metrics);
  }

  /** Load the sandbox, hand over the HTML, wait for the view to initialise, send tool input. */
  async start(): Promise<void> {
    const { iframe, resource, sandboxOrigin } = this.init;
    this.t0 = performance.now();
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    const ready = new Promise<void>((resolve) => {
      const l = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && (e.data as { method?: string } | null)?.method === "ui/notifications/sandbox-proxy-ready") {
          window.removeEventListener("message", l);
          resolve();
        }
      };
      window.addEventListener("message", l);
    });
    // First-render measurement comes from the sandbox proxy (it can see the inner document paint).
    this.msgListener = (e: MessageEvent) => {
      const d = e.data as { method?: string; params?: { ms?: number } } | null;
      if (e.source === iframe.contentWindow && d?.method === FIRST_RENDER_METHOD && typeof d.params?.ms === "number") {
        this.report({ firstRenderMs: d.params.ms, firstRenderSource: "proxy" });
      }
    };
    window.addEventListener("message", this.msgListener);

    iframe.src = sandboxUrl(sandboxOrigin, resource.csp as McpUiResourceCsp | undefined);
    await ready;
    if (this.closed) return;

    const initialized = new Promise<void>((resolve) => {
      this.bridge.oninitialized = () => {
        this.report({ initMs: Math.round(performance.now() - this.t0) });
        this.init.handlers.onInitialized?.();
        resolve();
      };
    });
    await this.bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    await this.bridge.sendSandboxResourceReady({
      html: resource.html,
      csp: resource.csp as McpUiResourceCsp | undefined,
      permissions: resource.permissions as McpUiResourcePermissions | undefined,
    });
    await initialized;
    if (this.closed) return;
    await this.bridge.sendToolInput({ arguments: this.init.input });
  }

  deliverResult(result: CallToolResult | Error): void {
    if (this.closed) return;
    if (result instanceof Error) {
      void this.bridge.sendToolCancelled({ reason: result.message });
      return;
    }
    this.resultSentAt = performance.now();
    void this.bridge.sendToolResult(result);
  }

  setHostContext(partial: McpUiHostContext): void {
    if (this.closed) return;
    this.ctx = { ...this.ctx, ...partial };
    this.bridge.setHostContext(this.ctx);
    void this.bridge.sendHostContextChange(partial);
  }

  /** Graceful teardown (spec: `ui/resource-teardown`), then close the transport. */
  async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.msgListener) window.removeEventListener("message", this.msgListener);
    try {
      await Promise.race([this.bridge.teardownResource({}), new Promise((r) => setTimeout(r, 400))]);
    } catch {
      /* the view may already be gone */
    }
    try {
      await this.bridge.close();
    } catch {
      /* ignore */
    }
  }
}
