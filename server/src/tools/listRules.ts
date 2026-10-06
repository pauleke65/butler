/** list_rules (contracts §3.8). */
import type { Rule } from "@butler/contracts";
import { ListRulesInput, ListRulesOutput } from "@butler/contracts";
import { fitSpoken } from "../lib/lintSpoken.js";
import { lowerFirst, stripEndPunct } from "../lib/spoken.js";
import { numberWord } from "../lib/time.js";
import { defineTool } from "./spec.js";

function byNewest(a: Rule, b: Rule): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

export function rulesSpoken(rules: Rule[], groups: { allowed: Rule[]; ask_first: Rule[]; never: Rule[] }): string {
  if (rules.length === 0) return "You don't have any rules yet.";
  const parts = [
    groups.ask_first.length ? `${numberWord(groups.ask_first.length)} ask first` : "",
    groups.never.length ? `${numberWord(groups.never.length)} never` : "",
    groups.allowed.length ? `${numberWord(groups.allowed.length)} allowed` : "",
  ].filter(Boolean);
  const counts = `You have ${numberWord(rules.length)} rule${rules.length === 1 ? "" : "s"}, ${parts.join(", ")}.`;
  const corrections = rules.filter((r) => r.origin.type === "correction").sort(byNewest).slice(0, 2);
  if (corrections.length === 0) return fitSpoken(counts);
  const texts = corrections.map((r) => lowerFirst(stripEndPunct(r.text)));
  const latest = `Your latest ${corrections.length === 1 ? "correction is" : "corrections are"} ${texts.join(", and ")}.`;
  const full = `${counts} ${latest}`;
  return full.split(/\s+/).length <= 35 ? full : fitSpoken(`${counts} Your latest correction is ${texts[0]}.`);
}

export const listRules = defineTool({
  name: "list_rules",
  title: "List rules",
  description:
    "Use when the customer asks what Butler is allowed to do, what their rules are, or what limits are set. Returns the active rules grouped as allowed, ask first and never.",
  input: ListRulesInput,
  output: ListRulesOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: { view: "rules", invoking: "Checking your rules…", invoked: "Here are your rules" },
  async handler(_args, ctx) {
    const rules = (await ctx.deps.repo.listRules(ctx.householdId, { activeOnly: true })).filter((r) => r.active).sort(byNewest);
    const groups = {
      allowed: rules.filter((r) => r.effect === "allow"),
      ask_first: rules.filter((r) => r.effect === "ask_first"),
      never: rules.filter((r) => r.effect === "never"),
    };
    return { data: { spoken_summary: rulesSpoken(rules, groups), ...groups } };
  },
});
