import type { CallRecord, JsonSchema } from "../mcp/types";

/** A tool as the brain sees it: model-visible tools of every connected server. */
export interface BrainTool {
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface BrainServer {
  id: string;
  name: string;
  /** Spoken name of the add-on, e.g. "Butler". */
  invocationName?: string;
}

export interface BrainContext {
  tools: BrainTool[];
  servers: BrainServer[];
  /** Executes a tool through the MCP client (and records timings). Never throws; failures are in `record.error`. */
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<CallRecord>;
}

export interface Conversation {
  id: string;
  /** Turn log, oldest first (also used by the transcript and the offline router). */
  turns: Array<{ utterance: string; spoken: string; calls: CallRecord[] }>;
  /** Last tool call of the previous turn - what "yes", "that" and "the second one" refer to. */
  lastCall?: CallRecord;
  /** Set when the previous reply asked the customer to disambiguate. */
  pendingClarification?: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    candidates: Array<{ id: string; label: string }>;
  };
  /** Bedrock Converse message history (opaque to everyone else). */
  messages: unknown[];
}

export interface RoutingDebug {
  tool?: string;
  server?: string;
  score?: number;
  reason: string;
  candidates?: Array<{ tool: string; score: number }>;
}

export interface BrainTurn {
  spoken: string;
  calls: CallRecord[];
  routing?: RoutingDebug;
  /** The reply is a question for the customer (clarification). */
  clarification?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; steps?: number };
}

export interface Brain {
  readonly mode: "offline" | "bedrock";
  turn(conv: Conversation, utterance: string, ctx: BrainContext): Promise<BrainTurn>;
}
