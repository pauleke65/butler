"use client";

import { useEffect, useRef, useState } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DARK_STYLE_VARIABLES, ViewHost, type ViewMetrics } from "@/lib/apps-host/view-host";
import type { DeviceSpec } from "@/lib/devices";
import type { JsonSchema, ToolInfo, ToolResult, UiResourcePayload } from "@/lib/mcp/types";
import { fetchUiResource } from "@/lib/state/use-simulator";
import { ShrinkIcon } from "./icons";
import type { ActiveView } from "@/lib/state/types";

interface Props {
  view: ActiveView;
  tool?: ToolInfo;
  sandboxOrigin: string;
  device: DeviceSpec;
  /** Inline slot on this screen (device px): the space right of the reply bubble, to the screen edge. */
  slot: { width: number; maxHeight: number; insetRight: number };
  fullscreen: boolean;
  onCallTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult>;
  onRequestDisplayMode(mode: "inline" | "fullscreen" | "pip"): "inline" | "fullscreen";
  onExitFullscreen(): void;
  onMetrics(m: ViewMetrics): void;
  onResource(r: UiResourcePayload): void;
  onNote?(msg: string): void;
}

/**
 * One MCP App view in a sandbox-proxy iframe (different origin), driven by an AppBridge.
 * The iframe element is stable across inline <-> fullscreen so the view never reloads.
 */
export function AppView({ view, tool, sandboxOrigin, device, slot, fullscreen, onCallTool, onRequestDisplayMode, onExitFullscreen, onMetrics, onResource, onNote }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<ViewHost>(undefined);
  const [height, setHeight] = useState(Math.round(device.height * 0.5));
  const [error, setError] = useState<string>();
  const cb = useRef({ onCallTool, onRequestDisplayMode, onMetrics, onResource, onNote });
  cb.current = { onCallTool, onRequestDisplayMode, onMetrics, onResource, onNote };

  const inlineWidth = slot.width;
  const maxInlineHeight = slot.maxHeight;

  const hostContext = (mode: "inline" | "fullscreen"): McpUiHostContext => ({
    theme: "dark",
    styles: { variables: DARK_STYLE_VARIABLES as never },
    displayMode: mode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: mode === "fullscreen" ? { height: device.height, width: device.width } : { maxHeight: maxInlineHeight, width: inlineWidth },
    // inline, the slot runs to the bezel: the screen margin is a safe area the view pads (and its carousel bleeds into)
    safeAreaInsets: { top: 0, right: mode === "fullscreen" ? 0 : slot.insetRight, bottom: 0, left: 0 },
    locale: typeof navigator !== "undefined" ? navigator.language : "en-US",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "web",
    userAgent: "addon-sim/0.1.0",
    deviceCapabilities: { touch: true, hover: false },
    ...(tool ? { toolInfo: { tool: { name: tool.name, description: tool.description, inputSchema: (tool.inputSchema ?? { type: "object" }) as JsonSchema as never, _meta: tool.meta } } } : {}),
  });

  useEffect(() => {
    let disposed = false;
    let host: ViewHost | undefined;
    setError(undefined);
    (async () => {
      try {
        const resource = await fetchUiResource(view.server, view.uri!);
        if (disposed) return;
        cb.current.onResource(resource);
        host = new ViewHost({
          iframe: iframeRef.current!,
          sandboxOrigin,
          resource,
          tool: tool ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, _meta: tool.meta } : undefined,
          input: view.input,
          hostContext: hostContext("inline"),
          handlers: {
            callTool: (p) => cb.current.onCallTool(p) as unknown as Promise<CallToolResult>,
            requestDisplayMode: (m) => cb.current.onRequestDisplayMode(m),
            onSize: (s) => {
              if (typeof s.height === "number") setHeight(Math.max(120, Math.min(Math.ceil(s.height), maxInlineHeight)));
            },
            onMetrics: (m) => cb.current.onMetrics({ ...m, resourceCached: resource.cached, resourceMs: resource.fetchMs }),
            onOpenLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
            onMessage: (p) => cb.current.onNote?.(`view message: ${JSON.stringify(p).slice(0, 160)}`),
            onLog: () => undefined,
          },
        });
        hostRef.current = host;
        await host.start();
        if (disposed) return;
        const resultPromise = view.result ? Promise.resolve(view.result) : view.resultPromise;
        resultPromise.then(
          (r) => host?.deliverResult(r as unknown as CallToolResult),
          (e) => host?.deliverResult(e instanceof Error ? e : new Error(String(e))),
        );
      } catch (err) {
        if (!disposed) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          cb.current.onNote?.(`view failed: ${msg}`);
        }
      }
    })();
    return () => {
      disposed = true;
      hostRef.current = undefined;
      void host?.teardown(); // teardown on replacement
    };
    // A new `view.id` means a new tool call -> new iframe. Everything else flows through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  useEffect(() => {
    hostRef.current?.setHostContext(hostContext(fullscreen ? "fullscreen" : "inline"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const style: React.CSSProperties = fullscreen
    ? { position: "absolute", inset: 0, zIndex: 30, width: "100%", height: "100%" }
    : { position: "relative", width: inlineWidth, height, maxHeight: maxInlineHeight };

  return (
    <div data-testid="app-view" data-display-mode={fullscreen ? "fullscreen" : "inline"} className="overflow-hidden" style={style}>
      <iframe
        ref={iframeRef}
        title={`${view.tool} view`}
        data-testid="app-iframe"
        // 2 px of bleed on every side, clipped by the wrapper: a scaled cross-origin frame otherwise shows a
        // hairline seam along its edges on the device canvas.
        className="absolute -left-[2px] -top-[2px] h-[calc(100%+4px)] w-[calc(100%+4px)] border-0 bg-transparent"
        referrerPolicy="origin"
      />
      {fullscreen && (
        <button
          type="button"
          onClick={onExitFullscreen}
          aria-label="Close full screen"
          title="Close full screen"
          className="absolute right-[40px] top-[26px] z-40 grid h-[56px] w-[56px] place-items-center rounded-full bg-[#19283c] text-[#d3ddeb] transition-colors hover:bg-[#22385a]"
        >
          <ShrinkIcon size={26} />
        </button>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 grid place-items-center rounded-[36px] bg-[#0e1c30] p-8 text-center text-[1.1em] text-red-200">
          <div>
            <div className="mb-2 text-[1.3em] font-semibold">This view could not be shown</div>
            <div className="font-mono text-[0.75em] opacity-80">{error}</div>
          </div>
        </div>
      )}
    </div>
  );
}
