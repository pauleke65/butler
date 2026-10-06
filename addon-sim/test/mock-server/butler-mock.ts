/**
 * A small stateful stand-in for the Butler MCP server. It copies Butler's tool names, descriptions
 * (contracts section 3) and result shapes closely enough that the simulator's offline brain and the
 * golden demo script can be exercised without the real stack. NOT a model of Butler's behaviour.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { buildViewHtml } from "../support/view-bundle";

type Obj = Record<string, unknown>;

interface Option { option_id: string; title: string; subtitle?: string; price?: { amount_minor: number; currency: "USD" }; tradeoff: string }
interface Decision { decision_id: string; plan_id: string; need_id: string; kind: "choose_option" | "approve_action"; question: string; options: Option[]; status: string; reason_held?: { rule_id: string; rule_text: string } }
interface Need { need_id: string; label: string; capability: string; status: string; note?: string }
interface Plan { plan_id: string; situation: string; kind: string; title: string; needs: Need[]; created_ms: number }
interface Receipt extends Obj { action_id: string; title: string }
interface Rule { rule_id: string; text: string; effect: string; template: string; params: Obj; policy_status: string; active: boolean }

export interface MockState {
  plans: Plan[];
  decisions: Decision[];
  receipts: Receipt[];
  rules: Rule[];
  draft?: Rule;
  seq: number;
  /** How long needs stay "doing" after a plan is created. */
  workMs: number;
}

export function newMockState(workMs = 1500): MockState {
  return {
    plans: [],
    decisions: [],
    receipts: [],
    rules: [{ rule_id: "rule_default_spend", text: "Ask me before spending more than 50 dollars.", effect: "ask_first", template: "spend_cap", params: { cap_minor: 5000 }, policy_status: "active", active: true }],
    seq: 0,
    workMs,
  };
}

const viewUris = {
  plan: "ui://mock/plan",
  options: "ui://mock/options",
  receipt: "ui://mock/receipt",
  actions: "ui://mock/actions",
  rule: "ui://mock/rule",
  rules: "ui://mock/rules",
} as const;

function result(sc: Obj, view?: string, isError = false) {
  return {
    structuredContent: sc,
    content: [{ type: "text" as const, text: JSON.stringify(sc) }],
    ...(isError ? { isError: true } : {}),
    ...(view ? { _meta: { ui: { resourceUri: view, invoking: "Working on it", invoked: "Here you go" } } } : {}),
  };
}
const err = (code: string, spoken: string, candidates?: unknown[]) => result({ ok: false, error: { code, message_spoken: spoken, ...(candidates ? { candidates } : {}) } }, undefined, true);

export function createMockButler(state: MockState): McpServer {
  const server = new McpServer({ name: "butler-mock", version: "0.0.1" }, { instructions: "Mock of the Butler add-on for simulator tests." });
  const id = (p: string) => `${p}_${(++state.seq).toString().padStart(4, "0")}`;
  const iso = () => new Date().toISOString();

  const needStatus = (p: Plan, n: Need) => (n.status === "needs_you" ? "needs_you" : Date.now() - p.created_ms < state.workMs ? "doing" : "done");
  const publicPlan = (p: Plan) => ({ ...p, needs: p.needs.map((n) => ({ ...n, status: needStatus(p, n) })) });
  const latestPlan = () => state.plans[state.plans.length - 1];
  const pending = () => state.decisions.filter((d) => d.status === "pending");

  const mkReceipt = (o: Obj): Receipt => {
    const r = { action_id: id("act"), household_id: "hh_demo", correlation_id: id("c"), status: "executed", reasons: [], context_used: [], alternatives: [], reversible: true, simulated: true, might_disagree: { score: 0 }, created_at: iso(), ...o } as unknown as Receipt;
    state.receipts.push(r);
    return r;
  };

  // seed history the way the demo does: a drinks purchase after plan creation is made on handle_situation.

  for (const [name, uri, title] of [
    ["plan-view", viewUris.plan, "Plan"],
    ["options-view", viewUris.options, "Options"],
    ["receipt-view", viewUris.receipt, "Receipt"],
    ["actions-view", viewUris.actions, "Actions"],
    ["rule-view", viewUris.rule, "Rule"],
    ["rules-view", viewUris.rules, "Rules"],
  ] as const) {
    registerAppResource(server, name, uri, { description: `${title} view`, mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await buildViewHtml(), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }],
    }));
  }

  registerAppTool(
    server,
    "handle_situation",
    {
      title: "Handle a situation",
      description:
        "Use when the customer describes something coming up or a state of their home, such as guests visiting, travelling, or running low on supplies. Creates a plan, starts working on it in the background, and returns what Butler will handle and what needs the customer.",
      inputSchema: { situation: z.string().min(3).max(400), when: z.string().optional() },
      annotations: { readOnlyHint: false, idempotentHint: false },
      _meta: { ui: { resourceUri: viewUris.plan } },
    },
    async ({ situation }) => {
      const s = situation.toLowerCase();
      const away = /travel|away|trip|holiday|vacation/.test(s);
      const plan_id = id("plan");
      const needs: Need[] = away
        ? [
            { need_id: id("need"), label: "Tell people you're away", capability: "messages", status: "doing" },
            { need_id: id("need"), label: "Block the calendar", capability: "calendar", status: "doing" },
            { need_id: id("need"), label: "Drinks for your parents", capability: "supplies", status: "doing" },
          ]
        : [
            { need_id: id("need"), label: "Invite 6 guests", capability: "messages", status: "doing" },
            { need_id: id("need"), label: "Add to calendar", capability: "calendar", status: "doing" },
            { need_id: id("need"), label: "Food and drinks", capability: "supplies", status: "doing" },
            { need_id: id("need"), label: "Cleaning", capability: "services", status: "needs_you" },
          ];
      const plan: Plan = { plan_id, situation, kind: away ? "away" : /friend|guest|dinner|coming over|host/.test(s) ? "hosting" : "other", title: away ? "Away Thursday to Sunday" : "Dinner for 6, Friday 7 PM", needs, created_ms: Date.now() };
      state.plans.push(plan);
      if (plan.kind === "hosting") {
        const need = needs[3]!;
        state.decisions.push({
          decision_id: id("dec"), plan_id, need_id: need.need_id, kind: "choose_option", status: "pending", question: "Which cleaner should I book?",
          options: [
            { option_id: "opt_sparkle", title: "Sparkle Cleaners", subtitle: "Thu 3 PM · 4.8 stars", price: { amount_minor: 6500, currency: "USD" }, tradeoff: "Cheapest, but only Thursday" },
            { option_id: "opt_brighthome", title: "BrightHome", subtitle: "Fri 10 AM · 4.9 stars", price: { amount_minor: 8500, currency: "USD" }, tradeoff: "Best rated, costs the most" },
            { option_id: "opt_tidyup", title: "TidyUp Co", subtitle: "Thu 9 AM · 4.5 stars", price: { amount_minor: 5900, currency: "USD" }, tradeoff: "Earliest slot" },
          ],
        });
        mkReceipt({
          plan_id, need_id: needs[2]!.need_id, title: "Bought drinks", cost: { amount_minor: 4200, currency: "USD" },
          action: { tool: "Supplies___checkout", args: { category: "drinks", amount_minor: 4200 } },
          reasons: ["Six guests are coming on Friday"], alternatives: [
            { option: "BudgetBasket drinks bundle, 36 dollars", rejected_because: "arrives Saturday, after the dinner" },
            { option: "Corner Cellar premium drinks bundle, 58 dollars", rejected_because: "over your 50 dollar limit" },
          ],
          authority: { decision: "ALLOW", principal: "butler-agent", rule_ids: ["rule_default_spend"], rule_texts: ["Ask me before spending more than 50 dollars."], evaluated_at: iso(), matcher_gateway_agree: true },
          might_disagree: { score: 0.45, top_reason: "It's above your usual drinks price" },
          spoken_summary: "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it.",
        });
      } else if (plan.kind === "away") {
        const askDrinks = state.rules.find((r) => r.active && r.template === "ask_category");
        if (askDrinks) {
          state.decisions.push({
            decision_id: id("dec"), plan_id, need_id: needs[2]!.need_id, kind: "approve_action", status: "pending",
            question: "Can I buy drinks for your parents for 31 dollars?",
            options: [{ option_id: "opt_approve_drinks", title: "Drinks for the weekend", price: { amount_minor: 3100, currency: "USD" }, tradeoff: "Held because you asked me to check first" }],
            reason_held: { rule_id: askDrinks.rule_id, rule_text: askDrinks.text },
          });
          needs[2]!.status = "needs_you";
          mkReceipt({
            plan_id, need_id: needs[2]!.need_id, title: "Drinks purchase held", status: "held_for_approval",
            action: { tool: "Supplies___checkout", args: { category: "drinks", amount_minor: 3100 } },
            reasons: ["You asked me to check before buying drinks"],
            authority: { decision: "DENY", principal: "butler-agent", rule_ids: [askDrinks.rule_id], rule_texts: [askDrinks.text], evaluated_at: iso(), matcher_gateway_agree: true },
            spoken_summary: "I held the drinks purchase because you asked me to check first.",
          });
        }
      }
      const handled = needs.filter((n) => n.status !== "needs_you").length;
      return result({
        ok: true,
        spoken_summary: plan.kind === "away" ? "Got it, you're away Thursday to Sunday. I'll tell people and look after the house supplies." : "Got it, six guests Friday at 7. I'll handle invites, the calendar and drinks, and I'll check with you on cleaning.",
        plan: publicPlan(plan), handled_by_butler: handled, needs_you: needs.length - handled,
      }, viewUris.plan);
    },
  );

  registerAppTool(
    server,
    "get_status",
    {
      title: "Get status",
      description:
        "Use when the customer asks how a plan is going, what's left, or whether Butler needs anything from them. Returns progress, what changed since they last asked, and any decisions waiting for them.",
      inputSchema: { plan_id: z.string().optional() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUris.plan } },
    },
    async ({ plan_id }) => {
      const plan = plan_id ? state.plans.find((p) => p.plan_id === plan_id) : latestPlan();
      if (!plan) return err("NO_ACTIVE_PLAN", "You don't have anything in progress. Tell me what's coming up.");
      const pend = pending().filter((d) => d.plan_id === plan.plan_id).slice(0, 3);
      const first = pend[0];
      const spoken = first
        ? first.kind === "approve_action"
          ? "One thing for you: should I buy drinks for 31 dollars? I held it because you asked me to check first."
          : "Invites went to all six, Friday's on the calendar, and I bought drinks for 42 dollars. One thing for you: which cleaner should I book?"
        : "Everything is handled.";
      return result({ ok: true, spoken_summary: spoken, plan: publicPlan(plan), done_since_last_check: [], pending_decisions: pend }, first?.kind === "choose_option" && pend.length === 1 ? viewUris.options : viewUris.plan);
    },
  );

  registerAppTool(
    server,
    "answer_decision",
    {
      title: "Answer decision",
      description: "Use when the customer chooses one of the options Butler offered, or approves or declines something Butler asked permission for.",
      inputSchema: { decision_id: z.string().optional(), choice: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: viewUris.receipt } },
    },
    async ({ decision_id, choice }) => {
      const open = pending();
      const dec = decision_id ? state.decisions.find((d) => d.decision_id === decision_id) : open.length === 1 ? open[0] : undefined;
      if (!dec) {
        return open.length > 1
          ? err("AMBIGUOUS_REFERENCE", "Did you mean the cleaner or the drinks?", open.map((d) => ({ id: d.decision_id, label: d.question })))
          : err("NOT_FOUND", "I couldn't find that one.");
      }
      const c = choice.toLowerCase();
      const ordinals = ["first", "second", "third", "1", "2", "3"];
      const ordIdx = ordinals.findIndex((o) => new RegExp(`\\b${o}\\b`).test(c));
      const opt =
        dec.options.find((o) => o.option_id === choice) ??
        dec.options.find((o) => c.includes(o.title.toLowerCase().split(" ")[0]!) || o.title.toLowerCase().includes(c)) ??
        (ordIdx >= 0 ? dec.options[ordIdx % 3] : undefined) ??
        (dec.kind === "approve_action" && /^(approve|yes)/.test(c) ? dec.options[0] : undefined);
      if (dec.kind === "approve_action" && /^(reject|no)/.test(c)) {
        dec.status = "rejected";
        return result({ ok: true, spoken_summary: "Okay, I won't buy it.", decision: dec }, viewUris.receipt);
      }
      if (!opt) return err("NOT_FOUND", "I couldn't find that one.");
      dec.status = "executed";
      const isDrinks = dec.kind === "approve_action";
      const receipt = mkReceipt({
        plan_id: dec.plan_id, need_id: dec.need_id, decision_id: dec.decision_id,
        title: isDrinks ? "Bought drinks" : `Booked ${opt.title}`, cost: opt.price,
        action: { tool: isDrinks ? "Supplies___checkout" : "Services___book_service", args: { provider: opt.title } },
        reasons: [isDrinks ? "You approved it" : "You chose it"], alternatives: [],
        authority: { decision: "ALLOW", principal: "approval-executor", rule_ids: [], rule_texts: [], evaluated_at: iso(), matcher_gateway_agree: true },
        result: { booking_id: id("bkg"), simulated: true },
        might_disagree: { score: isDrinks ? 0.1 : 0.55, top_reason: isDrinks ? undefined : "It's the first time I booked a cleaner" },
        spoken_summary: isDrinks ? "Done, I bought the drinks for 31 dollars." : `Booked ${opt.title} for ${(opt.price!.amount_minor / 100).toFixed(0)} dollars.`,
      });
      return result({ ok: true, spoken_summary: receipt.spoken_summary, decision: dec, receipt }, viewUris.receipt);
    },
  );

  registerAppTool(
    server,
    "list_actions",
    {
      title: "List actions",
      description:
        "Use when the customer asks what Butler did, what it bought, what it was blocked from doing, or what they might disagree with. Returns up to five actions, most relevant first.",
      inputSchema: {
        period: z.enum(["today", "this_week", "plan"]).optional(),
        filter: z.enum(["all", "purchases", "might_disagree", "blocked"]).optional(),
        plan_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUris.actions } },
    },
    async ({ filter = "all", period = "this_week" }) => {
      let list = [...state.receipts];
      if (filter === "might_disagree") list = list.filter((r) => ((r.might_disagree as { score: number }).score ?? 0) >= 0.3).sort((a, b) => (b.might_disagree as { score: number }).score - (a.might_disagree as { score: number }).score);
      else if (filter === "blocked") list = list.filter((r) => r.status === "blocked" || r.status === "held_for_approval");
      else if (filter === "purchases") list = list.filter((r) => (r.action as { tool: string }).tool.includes("checkout"));
      else list.reverse();
      const top = list.slice(0, 5);
      return result({
        ok: true,
        spoken_summary: top.length ? `${top.length} things you might disagree with, starting with ${top[0]!.title.toLowerCase()}.` : "Nothing stands out.",
        actions: top, total_count: list.length, filter, period,
      }, viewUris.actions);
    },
  );

  registerAppTool(
    server,
    "explain_action",
    {
      title: "Explain action",
      description: "Use when the customer asks why Butler did something, or wants details about a specific action, purchase, message or booking.",
      inputSchema: { action_id: z.string().optional(), reference: z.string().optional() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUris.receipt } },
    },
    async ({ action_id, reference }) => {
      const words = (reference ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !["the", "did", "you", "why"].includes(w));
      const matches = action_id
        ? state.receipts.filter((r) => r.action_id === action_id)
        : state.receipts.filter((r) => words.some((w) => r.title.toLowerCase().includes(w) || JSON.stringify(r.action).toLowerCase().includes(w)));
      if (!matches.length) return err("NOT_FOUND", "I couldn't find that one.");
      const r = matches[matches.length - 1]!;
      return result({ ok: true, spoken_summary: "I bought drinks for 42 dollars because six guests are coming. A cheaper option arrived Saturday, too late. Your 50 dollar limit allowed it.", receipt: r }, viewUris.receipt);
    },
  );

  registerAppTool(
    server,
    "object_to_action",
    {
      title: "Object to action",
      description:
        "Use when the customer disagrees with something Butler did or tells Butler how it should behave from now on, such as asking first, never doing something, or spending limits. Proposes a rule and asks the customer to confirm.",
      inputSchema: { correction: z.string(), action_id: z.string().optional(), reference: z.string().optional(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false },
      _meta: { ui: { resourceUri: viewUris.rule } },
    },
    async ({ correction, confirm }) => {
      if (confirm) {
        if (!state.draft) return err("NOT_FOUND", "I couldn't find that one.");
        const rule = { ...state.draft, policy_status: "active", active: true };
        state.rules.push(rule);
        state.draft = undefined;
        return result({ ok: true, spoken_summary: `Done. From now on, ${rule.text.charAt(0).toLowerCase()}${rule.text.slice(1)}`, rule, needs_confirmation: false }, viewUris.rule);
      }
      const m = /(buy|buying|purchase|purchasing|order)\s+(\w+)/i.exec(correction);
      if (!m || !/without asking|ask|before|never/i.test(correction)) {
        return err("RULE_UNSUPPORTED", "I can make rules about spending limits, asking before a type of purchase, asking before booking services, asking before messaging new people, or never messaging a specific person.");
      }
      const category = m[2]!.toLowerCase();
      state.draft = { rule_id: id("rule"), text: `Ask me before buying ${category}.`, effect: "ask_first", template: "ask_category", params: { category }, policy_status: "draft", active: false };
      return result({ ok: true, spoken_summary: `From now on, I'll ask before buying ${category}. Should I make that a rule?`, rule: state.draft, needs_confirmation: true }, viewUris.rule);
    },
  );

  registerAppTool(
    server,
    "list_rules",
    {
      title: "List rules",
      description: "Use when the customer asks what Butler is allowed to do, what their rules are, or what limits are set.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUris.rules } },
    },
    async () => {
      const active = state.rules.filter((r) => r.active);
      return result({ ok: true, spoken_summary: `You have ${active.length} rules.`, allowed: [], ask_first: active.filter((r) => r.effect === "ask_first"), never: [] }, viewUris.rules);
    },
  );

  // App-only helper, hidden from the model.
  registerAppTool(
    server,
    "get_plan",
    {
      title: "Get plan",
      description: "Refresh a plan (used by the plan view).",
      inputSchema: { plan_id: z.string().optional() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUris.plan, visibility: ["app"] } },
    },
    async ({ plan_id }) => {
      const plan = plan_id ? state.plans.find((p) => p.plan_id === plan_id) : latestPlan();
      if (!plan) return err("NOT_FOUND", "I couldn't find that one.");
      return result({ ok: true, spoken_summary: "Plan refreshed.", plan: publicPlan(plan) });
    },
  );

  return server;
}
