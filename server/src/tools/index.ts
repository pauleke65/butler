import { answerDecision } from "./answerDecision.js";
import { changeRule } from "./changeRule.js";
import { explainAction } from "./explainAction.js";
import { getPlan } from "./getPlan.js";
import { getStatus } from "./getStatus.js";
import { handleSituation } from "./handleSituation.js";
import { getLedgerPage, listActions } from "./listActions.js";
import { listRules } from "./listRules.js";
import { objectToAction } from "./objectToAction.js";
import type { RegisteredToolSpec } from "./spec.js";
import { undoAction } from "./undoAction.js";

/** Model-visible tools (contracts §3.2-3.10) followed by the app-only helpers (§3.11). */
export const TOOLS: readonly RegisteredToolSpec[] = [
  handleSituation,
  getStatus,
  answerDecision,
  listActions,
  explainAction,
  objectToAction,
  listRules,
  changeRule,
  undoAction,
  getLedgerPage,
  getPlan,
];

export const TOOL_BY_NAME: ReadonlyMap<string, RegisteredToolSpec> = new Map(TOOLS.map((t) => [t.name, t]));
