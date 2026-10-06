/**
 * Agent invoke client (contracts §5, ticket M-4).
 *
 * `AgentTransport` moves one AgentRequest envelope to the agent and returns its AgentResponse envelope:
 *  - `LocalAgentTransport`: HTTP POST to AGENT_LOCAL_URL (local topology, `butler_agent.server /invocations`)
 *  - `AgentCoreTransport`: AWS SDK InvokeAgentRuntime (SigV4) with a runtimeSessionId >= 33 chars
 * `AgentClientImpl` adds typed ops, session ids, timeouts and error mapping to the §14 codes.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import {
  AgentResponse as AgentResponseSchema,
  ERROR_CODES,
  Rule as RuleSchema,
  RuleDraft as RuleDraftSchema,
  type AgentRequest,
  type AgentResponse,
  type ErrorCode,
  type Rule,
  type RuleDraft,
} from "@butler/contracts";
import { ButlerError, SPOKEN_ERRORS } from "./errors.js";
import { ulid } from "./ids.js";

export interface InvokeOptions {
  timeoutMs: number;
  sessionId: string;
}

export interface AgentTransport {
  invoke(req: AgentRequest, opts: InvokeOptions): Promise<AgentResponse>;
}

const MIN_SESSION_LENGTH = 33;

/** runtimeSessionId must be >= 33 characters (contracts §5). */
export function padSessionId(id: string): string {
  return id.length >= MIN_SESSION_LENGTH ? id : id + "-".repeat(MIN_SESSION_LENGTH - id.length);
}

export class LocalAgentTransport implements AgentTransport {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async invoke(req: AgentRequest, opts: InvokeOptions): Promise<AgentResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-butler-session": opts.sessionId },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { cause: e, details: `agent unreachable: ${(e as Error).message}` });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `agent returned non-JSON (HTTP ${res.status})` });
    }
    const parsed = AgentResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: `agent returned an unexpected body (HTTP ${res.status})` });
    }
    return parsed.data;
  }
}

export class AgentCoreTransport implements AgentTransport {
  constructor(
    private readonly runtimeArn: string,
    private readonly client: Pick<BedrockAgentCoreClient, "send"> = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  ) {}

  async invoke(req: AgentRequest, opts: InvokeOptions): Promise<AgentResponse> {
    try {
      const res = await this.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: this.runtimeArn,
          runtimeSessionId: padSessionId(opts.sessionId),
          contentType: "application/json",
          accept: "application/json",
          payload: new TextEncoder().encode(JSON.stringify(req)),
        }),
        { abortSignal: AbortSignal.timeout(opts.timeoutMs) },
      );
      const body = res.response ? await (res.response as { transformToString(): Promise<string> }).transformToString() : "";
      const parsed = AgentResponseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("unexpected agent response shape");
      return parsed.data;
    } catch (e) {
      if (e instanceof ButlerError) throw e;
      throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { cause: e, details: `agent runtime invoke failed: ${(e as Error).message}` });
    }
  }
}

/** Placeholder when neither AGENT_LOCAL_URL nor AGENT_RUNTIME_ARN is configured. */
export class UnconfiguredAgentTransport implements AgentTransport {
  async invoke(): Promise<AgentResponse> {
    throw new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: "agent is not configured (set AGENT_LOCAL_URL or AGENT_RUNTIME_ARN)" });
  }
}

// ───────────────────────────── typed client ─────────────────────────────

export interface AgentCtx {
  householdId: string;
  correlationId: string;
}

export interface AgentClient {
  /** Fire-and-forget on the agent side: resolves once the agent accepted the work. */
  startPlan(ctx: AgentCtx, planId: string): Promise<void>;
  resumePlan(ctx: AgentCtx, planId: string, decisionId: string): Promise<void>;
  draftRule(ctx: AgentCtx, a: { correction: string; actionId?: string | undefined; baseRuleId?: string | undefined }): Promise<{ draft: RuleDraft | undefined; rule: Rule }>;
  /** `propagating` = the policy was created but is not ACTIVE yet (POLICY_PROPAGATING). */
  applyRule(ctx: AgentCtx, ruleId: string): Promise<{ rule: Rule | undefined; propagating: boolean }>;
  removeRule(ctx: AgentCtx, ruleId: string): Promise<{ rule: Rule | undefined }>;
}

export const AGENT_TIMEOUTS_MS = { start_plan: 4_000, resume_plan: 4_000, draft_rule: 8_000, apply_rule: 65_000, remove_rule: 35_000 } as const;

function isErrorCode(c: string): c is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(c);
}

/** Map an agent `{ok:false}` envelope to a ButlerError (§14). */
export function agentError(res: AgentResponse): ButlerError {
  const code = res.error?.code ?? "INTERNAL";
  const message = res.error?.message;
  if (isErrorCode(code)) {
    return new ButlerError(code, SPOKEN_ERRORS[code], message === undefined ? {} : { details: message });
  }
  return new ButlerError("INTERNAL", undefined, { details: `agent error ${code}${message ? `: ${message}` : ""}` });
}

export class AgentClientImpl implements AgentClient {
  constructor(private readonly transport: AgentTransport) {}

  private async call(
    op: AgentRequest["op"],
    req: AgentRequest,
    sessionId: string,
  ): Promise<AgentResponse> {
    return this.transport.invoke(req, { timeoutMs: AGENT_TIMEOUTS_MS[op], sessionId });
  }

  async startPlan(ctx: AgentCtx, planId: string): Promise<void> {
    const res = await this.call(
      "start_plan",
      { op: "start_plan", household_id: ctx.householdId, correlation_id: ctx.correlationId, plan_id: planId },
      `butler-${planId}`,
    );
    if (!res.ok) throw agentError(res);
  }

  async resumePlan(ctx: AgentCtx, planId: string, decisionId: string): Promise<void> {
    const res = await this.call(
      "resume_plan",
      { op: "resume_plan", household_id: ctx.householdId, correlation_id: ctx.correlationId, plan_id: planId, decision_id: decisionId },
      `butler-${planId}`,
    );
    if (!res.ok) throw agentError(res);
  }

  async draftRule(ctx: AgentCtx, a: { correction: string; actionId?: string | undefined; baseRuleId?: string | undefined }) {
    const res = await this.call(
      "draft_rule",
      {
        op: "draft_rule",
        household_id: ctx.householdId,
        correlation_id: ctx.correlationId,
        correction: a.correction,
        ...(a.actionId ? { action_id: a.actionId } : {}),
        ...(a.baseRuleId ? { base_rule_id: a.baseRuleId } : {}),
      },
      `butler-rules-${ctx.householdId}-${ulid()}`,
    );
    if (!res.ok) throw agentError(res);
    const rule = RuleSchema.safeParse(res.data?.["rule"]);
    if (!rule.success) throw new ButlerError("INTERNAL", undefined, { details: "agent draft_rule returned no valid rule" });
    const draft = RuleDraftSchema.safeParse(res.data?.["draft"]);
    return { draft: draft.success ? draft.data : undefined, rule: rule.data };
  }

  async applyRule(ctx: AgentCtx, ruleId: string) {
    const res = await this.call(
      "apply_rule",
      { op: "apply_rule", household_id: ctx.householdId, correlation_id: ctx.correlationId, rule_id: ruleId },
      `butler-rules-${ctx.householdId}-${ulid()}`,
    );
    const rule = RuleSchema.safeParse(res.data?.["rule"]);
    if (!res.ok) {
      if (res.error?.code === "POLICY_PROPAGATING") return { rule: rule.success ? rule.data : undefined, propagating: true };
      throw agentError(res);
    }
    if (!rule.success) throw new ButlerError("INTERNAL", undefined, { details: "agent apply_rule returned no valid rule" });
    return { rule: rule.data, propagating: rule.data.policy_status === "creating" };
  }

  async removeRule(ctx: AgentCtx, ruleId: string) {
    const res = await this.call(
      "remove_rule",
      { op: "remove_rule", household_id: ctx.householdId, correlation_id: ctx.correlationId, rule_id: ruleId },
      `butler-rules-${ctx.householdId}-${ulid()}`,
    );
    if (!res.ok) throw agentError(res);
    const rule = RuleSchema.safeParse(res.data?.["rule"]);
    return { rule: rule.success ? rule.data : undefined };
  }
}
