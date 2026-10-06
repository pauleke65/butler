/** get_status (contracts §3.3, ticket M-6). */
import type { Decision, Need, Plan } from "@butler/contracts";
import { GetStatusInput, GetStatusOutput } from "@butler/contracts";
import { ButlerError } from "../lib/errors.js";
import { fitSpoken } from "../lib/lintSpoken.js";
import { joinNames, lowerFirst, stripEndPunct } from "../lib/spoken.js";
import { numberWord, toUtcIso } from "../lib/time.js";
import { pendingDecisionsFor, requirePlan, TERMINAL_PLAN_STATUSES } from "./shared.js";
import { defineTool } from "./spec.js";

const PAST_TENSE: Record<string, string> = {
  invite: "invited", add: "added", order: "ordered", book: "booked", block: "blocked", tell: "told", stock: "stocked",
  reorder: "reordered", pause: "paused", let: "let", check: "checked", buy: "bought", send: "sent", cancel: "cancelled",
  work: "worked out", pick: "picked", arrange: "arranged", remind: "reminded",
};

/** "Invite 6 guests" -> "invited 6 guests". */
export function labelPast(label: string): string {
  const [first, ...rest] = label.trim().split(/\s+/);
  const verb = PAST_TENSE[(first ?? "").toLowerCase()];
  return verb ? [verb, ...rest].join(" ").replace(/\byour\b/g, "your") : `finished: ${lowerFirst(label)}`;
}

/** "Bought drinks from FreshCart, 42 dollars, arriving Friday" -> "bought drinks for 42 dollars". */
export function doneClause(need: Need): string {
  const m = /^(Bought|Booked|Ordered)\s+(.+?)(?:\s+from\s+[^,]+)?,\s*(\d+(?:\s\d+)?\s+dollars?)\b/i.exec(need.note ?? "");
  if (m) return `${m[1]!.toLowerCase()} ${m[2]} for ${m[3]}`;
  return labelPast(need.label);
}

function after(iso: string, since: string | undefined): boolean {
  if (!since) return true;
  const a = Date.parse(iso);
  const b = Date.parse(since);
  return Number.isNaN(a) || Number.isNaN(b) ? iso > since : a > b;
}

export function statusSpoken(plan: Plan, done: Need[], pending: Decision[]): string {
  const parts: string[] = [];
  if (done.length > 0) {
    const things = joinNames(done.map(doneClause));
    parts.push(`I ${things}.`);
  } else if (plan.status === "complete") {
    parts.push("Everything is done.");
  } else {
    const doing = plan.needs.filter((n) => n.status === "doing");
    parts.push(doing.length > 0 ? `Nothing new yet, I'm still working on ${numberWord(doing.length)} thing${doing.length === 1 ? "" : "s"}.` : "Nothing new since you last asked.");
  }
  const first = pending[0];
  if (pending.length === 1 && first) {
    parts.push(`One thing for you: ${lowerFirst(first.question)}`);
  } else if (pending.length > 1 && first) {
    parts.push(`I need ${numberWord(pending.length)} things from you, starting with: ${lowerFirst(first.question)}`);
  } else {
    const blocked = plan.needs.filter((n) => n.status === "blocked");
    if (blocked.length > 0) parts.push(`I got stuck on ${lowerFirst(stripEndPunct(blocked[0]?.label ?? "one thing"))}.`);
  }
  return fitSpoken(parts.join(" "));
}

export const getStatus = defineTool({
  name: "get_status",
  title: "Get status",
  description:
    "Use when the customer asks how a plan is going, what's left, or whether Butler needs anything from them. Returns progress, what changed since they last asked, and any decisions waiting for them.",
  input: GetStatusInput,
  output: GetStatusOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: { view: "plan", invoking: "Checking on things…", invoked: "Here's where things stand" },
  fieldDescriptions: { plan_id: "Optional plan id. Defaults to the most recently updated plan that isn't complete or cancelled." },
  async handler({ plan_id }, ctx) {
    const { deps, householdId } = ctx;
    let plan: Plan;
    if (plan_id) {
      plan = await requirePlan(ctx, plan_id);
    } else {
      const headers = await deps.repo.listPlanHeaders(householdId, 20);
      const latest = headers.find((p) => !TERMINAL_PLAN_STATUSES.has(p.status));
      if (!latest) throw new ButlerError("NO_ACTIVE_PLAN");
      plan = await requirePlan(ctx, latest.plan_id);
    }

    const done = plan.needs.filter((n) => n.status === "done" && after(n.updated_at, plan.last_status_read_at));
    const pending = (await pendingDecisionsFor(ctx, plan.plan_id)).slice(0, 3);

    // Stamp the read time for the next "since last check" (does not bump updated_at).
    await deps.repo.setPlanLastRead(householdId, plan.plan_id, toUtcIso(deps.now()));

    const onlyChoice = pending.length === 1 && pending[0]?.kind === "choose_option";
    return {
      data: {
        spoken_summary: statusSpoken(plan, done, pending),
        plan,
        done_since_last_check: done.map((n) => ({ need_id: n.need_id, label: n.label, ...(n.note ? { note: n.note } : {}) })),
        pending_decisions: pending,
      },
      view: onlyChoice ? "options" : "plan",
    };
  },
});
