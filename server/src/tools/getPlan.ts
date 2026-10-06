/** get_plan: app-only helper for the plan view refresh (contracts §3.11). */
import { GetPlanInput, GetPlanOutput } from "@butler/contracts";
import { fitSpoken } from "../lib/lintSpoken.js";
import { stripEndPunct } from "../lib/spoken.js";
import { numberWord } from "../lib/time.js";
import { requirePlan } from "./shared.js";
import { defineTool } from "./spec.js";

export const getPlan = defineTool({
  name: "get_plan",
  title: "Get plan",
  description: "App-only helper for the plan view. Returns the current state of one plan, including each need's status.",
  input: GetPlanInput,
  output: GetPlanOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: null,
  appOnly: true,
  fieldDescriptions: { plan_id: "The plan to load." },
  async handler({ plan_id }, ctx) {
    const plan = await requirePlan(ctx, plan_id);
    const open = plan.needs.filter((n) => n.status === "doing" || n.status === "needs_you").length;
    return {
      data: {
        spoken_summary: fitSpoken(
          open === 0 ? `${stripEndPunct(plan.title)} is all handled.` : `${stripEndPunct(plan.title)}, with ${numberWord(open)} thing${open === 1 ? "" : "s"} still open.`,
        ),
        plan,
      },
    };
  },
});
