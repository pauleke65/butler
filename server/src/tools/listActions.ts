/** list_actions (contracts §3.5, ticket M-8) and the app-only get_ledger_page (§3.11). */
import type { Receipt } from "@butler/contracts";
import { GetLedgerPageInput, GetLedgerPageOutput, ListActionsInput, ListActionsOutput } from "@butler/contracts";
import { ButlerError, invalidInput, notFound } from "../lib/errors.js";
import { fitSpoken } from "../lib/lintSpoken.js";
import { lowerFirst, stripEndPunct, upperFirst } from "../lib/spoken.js";
import { numberWord, startOfDayInTz } from "../lib/time.js";
import { applyFilter, householdTimezone, MIGHT_DISAGREE_THRESHOLD, newestFirst } from "./shared.js";
import { defineTool } from "./spec.js";

const MAX_ACTIONS = 5;
const SCAN_LIMIT = 200;
const FILTERS = ["all", "purchases", "might_disagree", "blocked"] as const;

function periodWord(period: string): string {
  return period === "today" ? "today" : period === "plan" ? "for this plan" : "this week";
}

export function actionsSpoken(actions: Receipt[], total: number, filter: string, period: string): string {
  const when = periodWord(period);
  if (total === 0) {
    if (filter === "might_disagree") return `Nothing from ${period === "today" ? "today" : period === "plan" ? "this plan" : "this week"} stands out as something you'd disagree with.`;
    if (filter === "blocked") return `Nothing was held or blocked ${when}.`;
    if (filter === "purchases") return `I haven't bought or booked anything ${when}.`;
    return `I haven't done anything ${when} yet.`;
  }
  const top = actions[0] as Receipt;
  const count = `${numberWord(total)} action${total === 1 ? "" : "s"}`;
  if (filter === "might_disagree") {
    const things = total === 1 ? "One thing" : `${upperFirst(numberWord(total))} things`;
    const why = top.might_disagree.top_reason ? ` ${upperFirst(stripEndPunct(top.might_disagree.top_reason))}.` : "";
    return fitSpoken(`${things} might bother you, starting with: ${lowerFirst(stripEndPunct(top.title))}.${why}`);
  }
  if (filter === "blocked") return fitSpoken(`${numberWord(total)} ${total === 1 ? "action was" : "actions were"} held or blocked ${when}. Most recent: ${stripEndPunct(top.title)}.`);
  if (filter === "purchases") return fitSpoken(`I made ${numberWord(total)} purchase${total === 1 ? "" : "s"} or booking${total === 1 ? "" : "s"} ${when}. Most recent: ${stripEndPunct(top.title)}.`);
  return fitSpoken(`I took ${count} ${when}. Most recent: ${stripEndPunct(top.title)}.`);
}

export const listActions = defineTool({
  name: "list_actions",
  title: "List actions",
  description:
    "Use when the customer asks what Butler did, what it bought, what it was blocked from doing, or what they might disagree with. Returns up to five actions, most relevant first.",
  input: ListActionsInput,
  output: ListActionsOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: { view: "actions", invoking: "Looking at what I did…", invoked: "Here's what I did" },
  fieldDescriptions: {
    period: "today, this_week (the last 7 days, default) or plan.",
    filter: "all (default), purchases, might_disagree (things the customer is likely to disagree with) or blocked (held or blocked actions).",
    plan_id: "Used when period is plan; defaults to the most recently updated plan.",
  },
  async handler({ period: periodArg, filter: filterArg, plan_id }, ctx) {
    const { deps, householdId } = ctx;
    const period = periodArg ?? "this_week";
    const filter = filterArg ?? "all";
    const now = deps.now();
    let receipts: Receipt[];

    if (period === "plan") {
      let planId = plan_id;
      if (planId) {
        if (!(await deps.repo.getPlan(householdId, planId))) throw notFound("I couldn't find that plan.");
      } else {
        planId = (await deps.repo.listPlanHeaders(householdId, 1))[0]?.plan_id;
        if (!planId) throw new ButlerError("NO_ACTIVE_PLAN");
      }
      receipts = newestFirst(await deps.repo.listReceiptsForPlan(planId));
    } else {
      const tz = await householdTimezone(ctx);
      const since = period === "today" ? startOfDayInTz(now, tz).getTime() : now.getTime() - 7 * 86_400_000;
      const all = await deps.repo.listReceipts(householdId, { newestFirst: true, limit: SCAN_LIMIT });
      receipts = all.filter((r) => Date.parse(r.created_at) >= since);
    }

    const filtered = applyFilter(receipts, filter);
    const ranked =
      filter === "might_disagree"
        ? [...filtered].sort((a, b) => b.might_disagree.score - a.might_disagree.score || (a.action_id < b.action_id ? 1 : -1))
        : filtered;
    const actions = ranked.slice(0, MAX_ACTIONS);
    return {
      data: {
        spoken_summary: actionsSpoken(actions, ranked.length, filter, period),
        actions,
        total_count: ranked.length,
        filter,
        period,
      },
    };
  },
});

function encodeCursor(actionId: string): string {
  return Buffer.from(JSON.stringify({ a: actionId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { a?: unknown }).a === "string") return (parsed as { a: string }).a;
  } catch {
    /* fall through */
  }
  throw invalidInput("cursor is not valid");
}

export const getLedgerPage = defineTool({
  name: "get_ledger_page",
  title: "Get ledger page",
  description:
    "App-only helper for the fullscreen ledger view. Returns one page of Butler's actions, newest first, with an optional filter and a cursor for the next page.",
  input: GetLedgerPageInput,
  output: GetLedgerPageOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: null,
  appOnly: true,
  fieldDescriptions: {
    cursor: "next_cursor from the previous page.",
    filter: `One of ${FILTERS.join(", ")}.`,
    limit: "Page size, 1 to 20 (default 10).",
  },
  async handler({ cursor, filter: filterArg, limit: limitArg }, ctx) {
    const filter = filterArg ?? "all";
    if (!(FILTERS as readonly string[]).includes(filter)) throw invalidInput(`filter must be one of ${FILTERS.join(", ")}`);
    const limit = limitArg ?? 10;
    let after = cursor ? decodeCursor(cursor) : undefined;

    const collected: Receipt[] = [];
    const batch = Math.max(25, limit * 3);
    for (let guard = 0; guard < 20 && collected.length <= limit; guard++) {
      const raw = await ctx.deps.repo.listReceipts(ctx.householdId, { newestFirst: true, limit: batch, ...(after ? { after } : {}) });
      if (raw.length === 0) break;
      collected.push(...applyFilter(raw, filter));
      after = (raw[raw.length - 1] as Receipt).action_id;
      if (raw.length < batch) break;
    }
    const page = collected.slice(0, limit);
    const hasMore = collected.length > limit;
    const last = page[page.length - 1];
    const n = page.length;
    return {
      data: {
        spoken_summary: n === 0 ? "There's nothing more to show." : `Showing ${numberWord(n)} action${n === 1 ? "" : "s"}.`,
        actions: page,
        ...(hasMore && last ? { next_cursor: encodeCursor(last.action_id) } : {}),
      },
    };
  },
});

export { MIGHT_DISAGREE_THRESHOLD };
