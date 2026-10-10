/**
 * Bedrock Converse tool-use loop (LLM_MODE=bedrock). Uses the default AWS credential chain.
 * The client is injectable so the loop can be unit-tested without AWS.
 */
import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import type { CallRecord } from "../mcp/types";
import { spokenFromResult } from "../mcp/tools";
import { buildSystemPrompt } from "./prompt";
import type { Brain, BrainContext, BrainTool, BrainTurn, Conversation } from "./types";

export interface ConverseLike {
  send(command: ConverseCommand): Promise<{
    output?: { message?: Message };
    stopReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}

export interface BedrockBrainOptions {
  model: string;
  region?: string;
  client?: ConverseLike;
  /** Hard cap on model round-trips per turn (a tool-use turn is 2). */
  maxSteps?: number;
  /** Hard cap on tool calls per turn. The prompt asks for one unless two are requested. */
  maxToolCalls?: number;
  maxHistoryMessages?: number;
}

/** Bedrock tool names: [a-zA-Z0-9_-]{1,64}. */
export function toolAlias(tool: BrainTool, all: BrainTool[]): string {
  const clash = all.filter((t) => t.name === tool.name).length > 1;
  const base = clash ? `${tool.server}__${tool.name}` : tool.name;
  return base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function toToolConfig(tools: BrainTool[]): { tools: Tool[] } {
  return {
    tools: tools.map((t) => {
      const schema = { ...t.inputSchema } as Record<string, unknown>;
      delete schema.$schema;
      if (!schema.type) schema.type = "object";
      return {
        toolSpec: {
          name: toolAlias(t, tools),
          description: t.description.slice(0, 1500) || t.name,
          inputSchema: { json: schema as never },
        },
      } satisfies Tool;
    }),
  };
}

/** Keep the model-facing payload small: spoken_summary first, then the structured data, capped. */
export function toolResultForModel(rec: CallRecord, maxChars = 6000): string {
  if (rec.error) return JSON.stringify({ ok: false, error: rec.error });
  const sc = rec.result?.structuredContent;
  const body = sc ?? { text: spokenFromResult(rec.result) };
  const json = JSON.stringify(body);
  return json.length > maxChars ? `${json.slice(0, maxChars)}...(truncated)` : json;
}

export class BedrockBrain implements Brain {
  readonly mode = "bedrock" as const;
  private client: ConverseLike;
  private opts: Required<Omit<BedrockBrainOptions, "client" | "region">>;

  constructor(options: BedrockBrainOptions) {
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region ?? "us-east-1" });
    this.opts = {
      model: options.model,
      maxSteps: options.maxSteps ?? 4,
      maxToolCalls: options.maxToolCalls ?? 2,
      maxHistoryMessages: options.maxHistoryMessages ?? 24,
    };
  }

  async turn(conv: Conversation, utterance: string, ctx: BrainContext): Promise<BrainTurn> {
    const messages = conv.messages as Message[];
    messages.push({ role: "user", content: [{ text: utterance }] });
    const system = [{ text: buildSystemPrompt(ctx.servers) }];
    const toolConfig = ctx.tools.length ? toToolConfig(ctx.tools) : undefined;
    const byAlias = new Map(ctx.tools.map((t) => [toolAlias(t, ctx.tools), t]));

    const calls: CallRecord[] = [];
    let spoken = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;

    while (steps < this.opts.maxSteps) {
      steps++;
      const resp = await this.client.send(
        new ConverseCommand({
          modelId: this.opts.model,
          system,
          messages: this.windowed(messages),
          toolConfig,
          // Amazon Nova: greedy decoding makes tool calls more reliable (Nova user guide).
          inferenceConfig: { maxTokens: 400, temperature: this.opts.model.includes("amazon.nova") ? 0 : 0.2 },
          ...(this.opts.model.includes("amazon.nova") ? { additionalModelRequestFields: { inferenceConfig: { topK: 1 } } } : {}),
        }),
      );
      inputTokens += resp.usage?.inputTokens ?? 0;
      outputTokens += resp.usage?.outputTokens ?? 0;
      const msg = resp.output?.message;
      if (!msg) break;
      messages.push(msg);
      const blocks = msg.content ?? [];
      const uses = blocks.filter((b): b is ContentBlock.ToolUseMember => "toolUse" in b && !!b.toolUse);
      const text = blocks.map((b) => ("text" in b && b.text ? b.text : "")).join(" ").trim();

      if (resp.stopReason !== "tool_use" || uses.length === 0) {
        spoken = text;
        break;
      }
      const results: ContentBlock[] = [];
      for (const [i, u] of uses.entries()) {
        const toolUse = u.toolUse!;
        const tool = byAlias.get(toolUse.name ?? "");
        if (!tool || calls.length >= this.opts.maxToolCalls) {
          results.push({
            toolResult: {
              toolUseId: toolUse.toolUseId,
              status: "error",
              content: [{ text: tool ? "Only one action per turn unless the customer asked for two." : `Unknown tool ${toolUse.name}` }],
            },
          });
          continue;
        }
        const rec = await ctx.callTool(tool.server, tool.name, (toolUse.input ?? {}) as Record<string, unknown>);
        calls.push(rec);
        void i;
        results.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            status: rec.error || rec.result?.isError ? "error" : "success",
            content: [{ text: toolResultForModel(rec) }],
          },
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (!spoken) {
      const last = calls[calls.length - 1];
      spoken = last ? (last.error ? "Sorry, something went wrong reaching that add-on." : spokenFromResult(last.result)) : "Sorry, I didn't catch that.";
      messages.push({ role: "assistant", content: [{ text: spoken }] });
    }
    const lastCall = calls[calls.length - 1];
    if (lastCall) conv.lastCall = lastCall;
    conv.turns.push({ utterance, spoken, calls });
    const err = lastCall?.result?.structuredContent as { error?: { code?: string } } | undefined;
    return {
      spoken,
      calls,
      clarification: err?.error?.code === "AMBIGUOUS_REFERENCE",
      routing: { reason: "bedrock converse", tool: lastCall?.tool, server: lastCall?.server },
      usage: { inputTokens, outputTokens, steps },
    };
  }

  /** Trim old history at a plain-user-text boundary so toolUse/toolResult pairs are never split. */
  private windowed(messages: Message[]): Message[] {
    if (messages.length <= this.opts.maxHistoryMessages) return messages;
    let start = messages.length - this.opts.maxHistoryMessages;
    while (start < messages.length) {
      const m = messages[start]!;
      const plainUser = m.role === "user" && (m.content ?? []).every((b) => "text" in b);
      if (plainUser) break;
      start++;
    }
    return messages.slice(start);
  }
}
