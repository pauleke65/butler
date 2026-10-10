/**
 * Bedrock (Claude Haiku) needs pass: Converse with a forced tool call for JSON output, 2.5 s timeout,
 * falls back to the keyword pass on any failure (contracts §12.1).
 *
 * The model decides kind / title / needs. Dates are resolved locally (chrono) so they never depend on
 * model date arithmetic.
 */
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { Capability, SituationKind } from "@butler/contracts";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import {
  normalizeNeeds,
  resolveTimes,
  type NeedsPass,
  type NeedsPassInput,
  type NeedsPassResult,
} from "./needsPass.js";
import { wallClock, weekdayName } from "./time.js";

export const NEEDS_PASS_PROMPT_VERSION = "needs-pass/1";

const SYSTEM_PROMPT = `You are the fast triage step of Butler, an Alexa+ add-on that handles household situations.
Given what the customer said, choose the situation kind and list what Butler should handle as 1 to 6 short needs.
Rules:
- kind: "hosting" (guests visiting), "away" (customer travelling), "running_low" (supplies running low) or "other".
- title: a short display title, max 60 characters, like "Dinner for 6, Friday 7 PM" or "Away, Thursday to Sunday".
- each need has a label (max 40 characters, imperative, e.g. "Invite 6 guests") and a capability:
  messages (email people), calendar (events), supplies (buy things), services (book a cleaner, ride, repair, pet care), context (look something up).
- hosting usually needs: invite guests (messages), add to calendar (calendar), food and drinks (supplies), a cleaner (services).
- away usually needs: tell people (messages), block the calendar (calendar), pause or redirect deliveries or stock for people staying (supplies).
- running_low needs: reorder the item (supplies).
- Use the contact groups provided to work out how many people a group like "the dinner crew" means.
- Never invent contacts, products, prices or providers. Reply only by calling the plan_needs tool.`;

const ModelOutput = z.object({
  kind: SituationKind,
  title: z.string().min(1).max(120),
  needs: z.array(z.object({ label: z.string().min(1).max(80), capability: Capability })).min(1).max(8),
});

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: SituationKind.options },
    title: { type: "string", maxLength: 60 },
    needs: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          label: { type: "string", maxLength: 40 },
          capability: { type: "string", enum: Capability.options },
        },
        required: ["label", "capability"],
      },
    },
  },
  required: ["kind", "title", "needs"],
} as const;

export interface BedrockNeedsPassOptions {
  modelId: string;
  fallback: NeedsPass;
  client?: Pick<BedrockRuntimeClient, "send">;
  region?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export class BedrockNeedsPass implements NeedsPass {
  private readonly client: Pick<BedrockRuntimeClient, "send">;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(private readonly opts: BedrockNeedsPassOptions) {
    // Real AWS credentials from the default provider chain (never the moto dummy keys).
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region ?? "us-east-1" });
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.logger = opts.logger ?? silentLogger;
  }

  async run(input: NeedsPassInput): Promise<NeedsPassResult> {
    const started = Date.now();
    try {
      const out = await this.invoke(input);
      this.logger.log("info", "needs_pass.bedrock", { ms: Date.now() - started, kind: out.kind });
      return out;
    } catch (e) {
      this.logger.log("warn", "needs_pass.fallback_to_keywords", {
        ms: Date.now() - started,
        reason: e instanceof Error ? e.message : String(e),
      });
      return this.opts.fallback.run(input);
    }
  }

  private buildRequest(input: NeedsPassInput): ConverseCommandInput {
    const w = wallClock(input.now, input.timezone);
    const groups: Record<string, number> = {};
    for (const c of input.contacts) for (const t of c.tags ?? []) groups[t] = (groups[t] ?? 0) + 1;
    const user = JSON.stringify({
      situation: input.situation,
      when: input.when ?? null,
      household_timezone: input.timezone,
      today: `${weekdayName(w.weekday)} ${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
      contact_count: input.contacts.length,
      contact_groups: groups,
      capabilities: Capability.options,
    });
    return {
      modelId: this.opts.modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 400, temperature: 0 },
      // Amazon Nova: greedy decoding for tool calls (Nova user guide, tool-use troubleshooting).
      ...(this.opts.modelId.includes("amazon.nova") ? { additionalModelRequestFields: { inferenceConfig: { topK: 1 } } } : {}),
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "plan_needs",
              description: "Return the situation kind, a title and the needs Butler will handle.",
              inputSchema: { json: TOOL_SCHEMA as unknown as Record<string, never> },
            },
          },
        ],
        toolChoice: { tool: { name: "plan_needs" } },
      },
    };
  }

  private async invoke(input: NeedsPassInput): Promise<NeedsPassResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.client.send(new ConverseCommand(this.buildRequest(input)), { abortSignal: ac.signal });
      const blocks = res.output?.message?.content ?? [];
      const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
      if (!toolUse) throw new Error("model did not return a tool call");
      const parsed = ModelOutput.parse(toolUse.input);
      const times = resolveTimes(input, parsed.kind);
      return {
        kind: parsed.kind,
        title: parsed.title.slice(0, 60),
        ...(times.starts_at ? { starts_at: times.starts_at } : {}),
        ...(times.ends_at ? { ends_at: times.ends_at } : {}),
        needs: normalizeNeeds(parsed.needs),
        source: "bedrock",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
