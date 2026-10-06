import type { CallRecord, ElicitationRequestInfo } from "./mcp/types";
import type { RoutingDebug } from "./brain/types";

/** NDJSON events streamed by POST /api/turn. */
export type TurnEvent =
  | { type: "turn_start"; turnId: string; utterance: string; llmMode: "offline" | "bedrock" }
  | { type: "call_start"; callId: string; server: string; tool: string; args: Record<string, unknown>; uiResourceUri?: string; at: number }
  | { type: "call_end"; record: CallRecord }
  | { type: "turn_end"; turnId: string; spoken: string; routing?: RoutingDebug; clarification?: boolean; ms: number; usage?: { inputTokens?: number; outputTokens?: number; steps?: number } }
  | { type: "error"; message: string };

/** SSE events on GET /api/events (things that can happen outside a turn). */
export type HubEvent =
  | { type: "elicitation"; request: ElicitationRequestInfo }
  | { type: "elicitation_done"; id: string }
  | { type: "hello" };
