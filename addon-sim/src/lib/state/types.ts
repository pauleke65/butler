import type { CallRecord, ToolResult } from "../mcp/types";
import type { DeviceId } from "../devices";
import type { RoutingDebug } from "../brain/types";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
  /** tool(s) used for this reply (assistant entries) */
  tools?: string[];
  routing?: RoutingDebug;
  interim?: boolean;
  /** which TTS engine voiced it */
  engine?: string;
}

export type RenderKind = "view" | "hydrated" | "suppressed" | "none";

export interface RenderInfo {
  kind: RenderKind;
  uri?: string;
  /** Result delivered to the view -> first paint (ms). */
  firstRenderMs?: number;
  initMs?: number;
  resourceCached?: boolean;
  resourceMs?: number;
  carousel?: boolean;
  /** true when the 500 ms first-render budget is exceeded */
  slow?: boolean;
  note?: string;
}

export interface InspectorCall {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  origin: CallRecord["origin"];
  startedAt: number;
  status: "running" | "ok" | "error";
  record?: CallRecord;
  render?: RenderInfo;
  /** the utterance that led to this call */
  utterance?: string;
}

export interface ActiveView {
  /** unique per rendering (iframe lifecycle) */
  id: string;
  callId: string;
  kind: "app" | "hydrated";
  server: string;
  tool: string;
  uri?: string;
  input: Record<string, unknown>;
  /** resolves when the tool result is known (may already be resolved) */
  resultPromise: Promise<ToolResult>;
  /** set once resolved, used to remount instantly (device switch) */
  result?: ToolResult;
  /** performance.now() at which the host first knew about the call (for the first-render budget) */
  openedAt: number;
}

export type Status = "idle" | "listening" | "thinking" | "speaking";

export interface SessionExport {
  exportedAt: string;
  llmMode: string;
  device: DeviceId;
  servers: Array<{ id: string; name: string; url: string; protocolVersion?: string; serverInfo?: unknown }>;
  transcript: TranscriptEntry[];
  calls: InspectorCall[];
}
