/** handle_situation (contracts §3.2, ticket M-5): needs pass -> write plan -> fire-and-forget agent start. */
import type { Need, Plan } from "@butler/contracts";
import { HandleSituationInput, HandleSituationOutput } from "@butler/contracts";
import { fitSpoken } from "../lib/lintSpoken.js";
import {
  buildKeywordResult,
  type NeedsPassInput,
  type NeedsPassResult,
} from "../lib/needsPass.js";
import { joinNames } from "../lib/spoken.js";
import { numberWord, spokenDay, spokenTime, spokenWeekdayOrDate, toUtcIso } from "../lib/time.js";
import { countNeeds, needsCustomer, TERMINAL_PLAN_STATUSES, householdTimezone } from "./shared.js";
import { defineTool, type ToolContext } from "./spec.js";

const WRITE_AND_KICK_RESERVE_MS = 700;

async function runNeedsPass(ctx: ToolContext, input: NeedsPassInput): Promise<NeedsPassResult> {
  const { deps } = ctx;
  const budget = Math.max(300, deps.config.handleSituationBudgetMs - WRITE_AND_KICK_RESERVE_MS);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });
  try {
    const winner = await Promise.race([deps.needsPass.run(input).catch((e: unknown) => e), timeout]);
    if (winner === "timeout" || winner instanceof Error || !winner || typeof winner !== "object" || !("needs" in winner)) {
      ctx.log.log("warn", "needs_pass.budget_fallback", { budget_ms: budget });
      return buildKeywordResult(input);
    }
    return winner as NeedsPassResult;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function plansOverlap(
  existing: Plan,
  incoming: { kind: Plan["kind"]; starts_at?: string | undefined; ends_at?: string | undefined; situation: string },
): boolean {
  if (existing.kind !== incoming.kind) return false;
  if (TERMINAL_PLAN_STATUSES.has(existing.status)) return false;
  if (existing.starts_at && incoming.starts_at) {
    const s1 = Date.parse(existing.starts_at);
    const s2 = Date.parse(incoming.starts_at);
    if (!Number.isNaN(s1) && !Number.isNaN(s2)) {
      const e1 = existing.ends_at ? Date.parse(existing.ends_at) : s1 + 3 * 3600_000;
      const e2 = incoming.ends_at ? Date.parse(incoming.ends_at) : s2 + 3 * 3600_000;
      return s1 < e2 && s2 < e1;
    }
  }
  if (!existing.starts_at && !incoming.starts_at) return normalizeText(existing.situation) === normalizeText(incoming.situation);
  return false;
}

function capabilityPhrase(kind: Plan["kind"], need: Need): string {
  switch (need.capability) {
    case "messages":
      return kind === "hosting" ? "invites" : kind === "away" ? "letting people know" : "messages";
    case "calendar":
      return kind === "away" ? "your calendar" : "the calendar";
    case "supplies":
      return /drink/i.test(need.label) ? "drinks" : kind === "running_low" ? "the reorder" : "supplies";
    case "services":
      return /clean/i.test(need.label) ? "cleaning" : "bookings";
    default:
      return "the details";
  }
}

export function planSpoken(plan: Plan, now: Date, tz: string): string {
  const handled = plan.needs.filter((n) => !needsCustomer(n));
  const asks = plan.needs.filter(needsCustomer);
  const handledText = joinNames(handled.map((n) => capabilityPhrase(plan.kind, n)));
  const askText = joinNames(asks.map((n) => capabilityPhrase(plan.kind, n)));
  const start = plan.starts_at ? new Date(plan.starts_at) : undefined;
  const end = plan.ends_at ? new Date(plan.ends_at) : undefined;
  const guests = /^Invite (\d+) guests$/.exec(plan.needs.find((n) => n.capability === "messages")?.label ?? "");

  let lead: string;
  if (plan.kind === "hosting") {
    const who = guests ? `${numberWord(Number(guests[1]))} guests` : "guests";
    lead = start ? `Got it, ${who} ${spokenDay(start, now, tz)} at ${spokenTime(start, tz)}.` : `Got it, ${who} coming over.`;
  } else if (plan.kind === "away") {
    lead =
      start && end && spokenWeekdayOrDate(start, now, tz) !== spokenWeekdayOrDate(end, now, tz)
        ? `Got it, you're away ${spokenWeekdayOrDate(start, now, tz)} to ${spokenWeekdayOrDate(end, now, tz)}.`
        : start
          ? `Got it, you're away ${spokenDay(start, now, tz)}.`
          : "Got it, you're away.";
  } else if (plan.kind === "running_low") {
    lead = "Got it, I'll take care of restocking.";
  } else {
    lead = "Got it, I'm on it.";
  }

  const tail = [
    handledText ? `I'll handle ${handledText}` : "",
    askText ? `${handledText ? ", and I'll " : "I'll "}check with you on ${askText}` : "",
  ].join("");
  return fitSpoken(tail ? `${lead} ${tail}.` : lead);
}

export const handleSituation = defineTool({
  name: "handle_situation",
  title: "Handle a situation",
  description:
    "Use when the customer describes something coming up or a state of their home, such as guests visiting, travelling, or running low on supplies. Creates a plan, starts working on it in the background, and returns what Butler will handle and what needs the customer.",
  input: HandleSituationInput,
  output: HandleSituationOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ui: { view: "plan", invoking: "Working on it…", invoked: "Here's the plan" },
  fieldDescriptions: {
    situation: "The customer's own words describing what is happening, 3 to 400 characters, e.g. 'six friends are coming over Friday at 7'.",
    when: "Optional time as an ISO 8601 date-time or a natural phrase such as 'Friday at 7'. Resolved in the household's timezone.",
  },
  async handler({ situation, when }, ctx) {
    const { deps, householdId } = ctx;
    const now = deps.now();
    const tz = await householdTimezone(ctx);
    const [contacts, headers] = await Promise.all([deps.repo.listContacts(householdId), deps.repo.listPlanHeaders(householdId, 20)]);

    const input: NeedsPassInput = { situation, when, timezone: tz, now, contacts };
    const result = await runNeedsPass(ctx, input);

    // Duplicate plan: return the existing plan (MVP behaviour from §3.2).
    const dup = headers.find((p) => plansOverlap(p, { kind: result.kind, starts_at: result.starts_at, ends_at: result.ends_at, situation }));
    if (dup) {
      const existing = await deps.repo.getPlan(householdId, dup.plan_id);
      if (existing) {
        const day = existing.starts_at ? spokenDay(new Date(existing.starts_at), now, tz) : undefined;
        return {
          data: {
            spoken_summary: fitSpoken(`You already have a plan ${day ? `for ${day}` : "like that"}. Here's where it stands.`),
            plan: existing,
            ...countNeeds(existing.needs),
          },
        };
      }
    }

    const planId = deps.newId("plan");
    const stamp = toUtcIso(now);
    const needs: Need[] = result.needs.map((n) => ({
      need_id: deps.newId("need"),
      plan_id: planId,
      label: n.label,
      capability: n.capability,
      // The agent only works on `doing` needs and flips a service to `needs_you` itself when it asks the customer
      // to choose (request_decision), so a service starts as `doing`.
      status: "doing",
      action_ids: [],
      updated_at: stamp,
    }));
    const plan: Plan = {
      plan_id: planId,
      household_id: householdId,
      situation,
      kind: result.kind,
      title: result.title,
      ...(result.starts_at ? { starts_at: result.starts_at } : {}),
      ...(result.ends_at ? { ends_at: result.ends_at } : {}),
      status: "active",
      needs,
      created_at: stamp,
      updated_at: stamp,
    };
    await deps.repo.putPlan(plan);

    // Fire and forget: the agent works in the background; never await completion (§3.2 step 3).
    const agentCtx = { householdId, correlationId: ctx.correlationId };
    deps.background("agent.start_plan", async () => {
      try {
        await deps.agent.startPlan(agentCtx, planId);
      } catch (e) {
        ctx.log.log("error", "agent.start_plan.failed", { plan_id: planId, error: e instanceof Error ? e.message : String(e) });
        const t = toUtcIso(deps.now());
        for (const n of needs) {
          if (n.status === "doing") {
            await deps.repo.putNeed({ ...n, status: "blocked", note: "I couldn't reach my planner. Ask me to try again.", updated_at: t });
          }
        }
        await deps.repo.touchPlan(householdId, planId, t);
        throw e;
      }
    });

    return {
      data: {
        spoken_summary: planSpoken(plan, now, tz),
        plan,
        ...countNeeds(needs),
      },
    };
  },
});
