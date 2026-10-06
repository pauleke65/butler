/** Scriptable stand-ins for the Python agent and approval executor (tests and the fixture server). */
import type { Decision, Receipt, Rule, RuleDraft } from "@butler/contracts";
import type { Deps } from "../deps.js";
import type { AgentClient, AgentCtx } from "../lib/agentClient.js";
import { ButlerError } from "../lib/errors.js";
import type { ExecutorClient, ExecutorCtx, UndoResult } from "../lib/executorClient.js";
import type { Repo } from "../lib/repo.js";
import { toUtcIso } from "../lib/time.js";

// ───────────────────────────── fake agent ─────────────────────────────

export interface AgentCall {
  op: "start_plan" | "resume_plan" | "draft_rule" | "apply_rule" | "remove_rule";
  args: Record<string, unknown>;
}

/** A scriptable stand-in for the Python agent. Rule ops write to the repo like the real agent does. */
export class FakeAgent implements AgentClient {
  calls: AgentCall[] = [];
  failStart: ButlerError | undefined;
  nextDraftError: ButlerError | undefined;
  propagating = false;
  constructor(
    private readonly repo: Repo,
    private readonly now: () => Date,
    private readonly newId: Deps["newId"],
  ) {}

  async startPlan(ctx: AgentCtx, planId: string): Promise<void> {
    this.calls.push({ op: "start_plan", args: { planId, ...ctx } });
    if (this.failStart) throw this.failStart;
  }
  async resumePlan(ctx: AgentCtx, planId: string, decisionId: string): Promise<void> {
    this.calls.push({ op: "resume_plan", args: { planId, decisionId, ...ctx } });
  }

  private draftFor(correction: string, baseRule: Rule | null | undefined): RuleDraft {
    const c = correction.toLowerCase();
    const num = /(\d+)\s*(dollars|bucks|usd)?/.exec(c);
    if (/\b(limit|spend|cap|raise|lower)\b/.test(c) && num) {
      const cap = Number(num[1]) * 100;
      return { template: "spend_cap", params: { tools: ["Supplies___checkout", "Services___book_service"], cap_minor: cap }, text: `Ask me before spending more than ${num[1]} dollars.`, effect: "ask_first", confidence: 0.9 };
    }
    const cat = /\b(drinks|groceries|household|toiletries|gifts)\b/.exec(c);
    if (cat && /\b(ask|check|without|before)\b/.test(c)) {
      return { template: "ask_category", params: { category: cat[1] }, text: `Ask me before buying ${cat[1]}.`, effect: "ask_first", confidence: 0.92 };
    }
    if (/\bnever\b.*\bmessage\b/.test(c)) {
      return { template: "never_contact", params: { contact_id: "c_jordan" }, text: "Never message Jordan.", effect: "never", confidence: 0.9 };
    }
    void baseRule;
    return { template: "unsupported" as RuleDraft["template"], params: {}, text: "", effect: "ask_first", confidence: 0.1 };
  }

  async draftRule(ctx: AgentCtx, a: { correction: string; actionId?: string | undefined; baseRuleId?: string | undefined }) {
    this.calls.push({ op: "draft_rule", args: { ...a, ...ctx } });
    if (this.nextDraftError) {
      const e = this.nextDraftError;
      this.nextDraftError = undefined;
      throw e;
    }
    const base = a.baseRuleId ? await this.repo.getRule(ctx.householdId, a.baseRuleId) : null;
    const draft = this.draftFor(a.correction, base);
    if ((draft.template as string) === "unsupported") throw new ButlerError("RULE_UNSUPPORTED");
    const stamp = toUtcIso(this.now());
    const rule: Rule = {
      rule_id: this.newId("rule"),
      household_id: ctx.householdId,
      text: draft.text,
      effect: draft.effect,
      template: draft.template as Rule["template"],
      params: draft.params,
      cedar_statement: `// compiled ${draft.template}`,
      policy_status: "draft",
      origin: { type: "correction", utterance: a.correction, ...(a.actionId ? { action_id: a.actionId } : {}), created_at: stamp },
      active: false,
      created_at: stamp,
      updated_at: stamp,
    };
    await this.repo.putRule(rule);
    return { draft, rule };
  }

  async applyRule(ctx: AgentCtx, ruleId: string) {
    this.calls.push({ op: "apply_rule", args: { ruleId, ...ctx } });
    const rule = await this.repo.getRule(ctx.householdId, ruleId);
    if (!rule) throw new ButlerError("NOT_FOUND");
    const next: Rule = this.propagating
      ? { ...rule, policy_status: "creating", active: false, updated_at: toUtcIso(this.now()) }
      : { ...rule, policy_status: "active", active: true, policy_id: `policy-${ruleId.slice(-6)}`, updated_at: toUtcIso(this.now()) };
    await this.repo.putRule(next);
    return { rule: next, propagating: this.propagating };
  }

  async removeRule(ctx: AgentCtx, ruleId: string) {
    this.calls.push({ op: "remove_rule", args: { ruleId, ...ctx } });
    const rule = await this.repo.getRule(ctx.householdId, ruleId);
    if (!rule) throw new ButlerError("NOT_FOUND");
    const next: Rule = { ...rule, policy_status: "disabled", active: false, updated_at: toUtcIso(this.now()) };
    await this.repo.putRule(next);
    return { rule: next };
  }
}

// ───────────────────────────── fake executor ─────────────────────────────

export class FakeExecutor implements ExecutorClient {
  calls: Array<{ mode: "decision" | "undo"; args: Record<string, unknown> }> = [];
  fail: ButlerError | undefined;
  constructor(
    private readonly repo: Repo,
    private readonly now: () => Date,
    private readonly newId: Deps["newId"],
  ) {}

  async runDecision(ctx: ExecutorCtx, decisionId: string, optionId: string) {
    this.calls.push({ mode: "decision", args: { decisionId, optionId, ...ctx } });
    if (this.fail) throw this.fail;
    const found = await this.repo.findDecision(ctx.householdId, decisionId);
    if (!found) throw new ButlerError("NOT_FOUND");
    const option = found.options.find((o) => o.option_id === optionId);
    if (!option?.action_draft) throw new ButlerError("INVALID_INPUT");
    const approved = await this.repo.transitionDecision(ctx.householdId, found.plan_id, decisionId, "pending", "approved", { chosen_option_id: optionId });
    if (!approved) throw new ButlerError("INVALID_INPUT", "decision is not pending");
    const stamp = toUtcIso(this.now());
    const receipt: Receipt = {
      action_id: this.newId("act"),
      household_id: ctx.householdId,
      plan_id: found.plan_id,
      need_id: found.need_id,
      decision_id: decisionId,
      correlation_id: ctx.correlationId,
      action: { tool: option.action_draft.tool, args: option.action_draft.args },
      title: `Booked ${option.title}`,
      status: "executed",
      reasons: [`You chose ${option.title}`],
      context_used: [],
      alternatives: [],
      authority: { decision: "ALLOW", principal: "approval-executor", rule_ids: [], rule_texts: [], evaluated_at: stamp, matcher_gateway_agree: true },
      ...(option.price ? { cost: option.price } : {}),
      reversible: true,
      might_disagree: { score: 0.3, top_reason: "It's the first time I booked one" },
      simulated: true,
      spoken_summary: `I booked ${option.title} because you chose it. Your approval let it through.`,
      created_at: stamp,
    };
    await this.repo.putReceipt(receipt);
    const executed = await this.repo.transitionDecision(ctx.householdId, found.plan_id, decisionId, "approved", "executed", { result_action_id: receipt.action_id });
    const needs = await this.repo.listNeeds(found.plan_id);
    const need = needs.find((n) => n.need_id === found.need_id);
    if (need) await this.repo.putNeed({ ...need, status: "done", action_ids: [...need.action_ids, receipt.action_id], decision_id: decisionId, updated_at: stamp });
    return { decision: executed as Decision, receipt };
  }

  async undo(ctx: ExecutorCtx, actionId: string): Promise<UndoResult> {
    this.calls.push({ mode: "undo", args: { actionId, ...ctx } });
    if (this.fail) throw this.fail;
    const original = await this.repo.getReceipt(ctx.householdId, actionId);
    if (!original) throw new ButlerError("NOT_FOUND");
    const stamp = toUtcIso(this.now());
    const undoTool = original.action.tool === "Supplies___checkout" ? "Supplies___refund" : original.action.tool === "Services___book_service" ? "Services___cancel_booking" : "Calendar___delete_event";
    const undo: Receipt = {
      ...original,
      action_id: this.newId("act"),
      action: { tool: undoTool, args: {} },
      title: `Undid: ${original.title}`,
      status: "executed",
      undo_of: original.action_id,
      reversible: false,
      authority: { ...original.authority, principal: "approval-executor", decision: "ALLOW", evaluated_at: stamp },
      spoken_summary: `I undid ${original.title.toLowerCase()} because you asked me to. It's all reversed.`,
      created_at: stamp,
    };
    await this.repo.putReceipt(undo);
    const updatedOriginal: Receipt = { ...original, status: "undone" };
    await this.repo.putReceipt(updatedOriginal);
    return { undo, original: updatedOriginal };
  }
}

