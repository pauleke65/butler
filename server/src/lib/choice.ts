/** Choice resolver for answer_decision (ticket M-7): "the second one", "Sparkle", "approve", option ids. */
import type { Decision, DecisionOption } from "@butler/contracts";
import { ButlerError } from "./errors.js";
import { ambiguity, optionCandidates, parseOrdinal, resolveReference, toCandidates } from "./resolver.js";

export type ChoiceOutcome =
  | { kind: "option"; option: DecisionOption }
  | { kind: "reject"; option?: DecisionOption };

const APPROVE_ONLY =
  /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|go ahead|do it|go for it|confirm|confirmed|that'?s fine|sounds good|please do|absolutely|of course|proceed|accept|all right|alright)( please| thanks| thank you)?$/;
const REJECT_ONLY =
  /^(no|nope|nah|reject|rejected|decline|declined|deny|denied|skip( it)?|cancel|don'?t( do it| book it| buy it)?|do not|not now|never ?mind|forget it|pass|no thanks|no thank you|stop|leave it)$/;
const LEADING_APPROVE = /^(yes|yeah|yep|sure|ok|okay|please|go ahead and|go with|choose|pick|select|book|buy|take|i'?ll take|i want|let'?s go with|approve)\b\s*/;
const LEADING_REJECT = /^(no|nope|nah|don'?t|do not|never|skip|decline|reject)\b/;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[.!?,;]+/g, " ").replace(/\s+/g, " ").trim();
}

function minBy(options: DecisionOption[], pick: (o: DecisionOption) => number | undefined, dir: 1 | -1): DecisionOption | undefined {
  let best: DecisionOption | undefined;
  let bestV: number | undefined;
  for (const o of options) {
    const v = pick(o);
    if (v === undefined) continue;
    if (bestV === undefined || (dir === 1 ? v < bestV : v > bestV)) {
      best = o;
      bestV = v;
    }
  }
  return best;
}

function asOutcome(option: DecisionOption): ChoiceOutcome {
  // An option without an action draft is the "skip" choice.
  return option.action_draft ? { kind: "option", option } : { kind: "reject", option };
}

function listSpoken(options: DecisionOption[]): string {
  const t = options.slice(0, 3).map((o) => o.title);
  return t.length === 2 ? `${t[0]} or ${t[1]}` : `${t.slice(0, -1).join(", ")}, or ${t[t.length - 1]}`;
}

export function resolveChoice(decision: Decision, choice: string, now: number): ChoiceOutcome {
  const options = decision.options;
  const raw = choice.trim();

  const byId = options.find((o) => o.option_id === raw);
  if (byId) return asOutcome(byId);

  const text = normalize(raw);

  const approveWithDefault = (): ChoiceOutcome => {
    if (decision.kind === "approve_action" || options.length === 1) {
      const only = options[0];
      if (!only) throw new ButlerError("NOT_FOUND");
      return asOutcome(only);
    }
    const def = options.find((o) => o.option_id === decision.default_option_id);
    if (def) return asOutcome(def);
    throw new ButlerError("AMBIGUOUS_REFERENCE", `Which one should I go with: ${listSpoken(options)}?`, {
      candidates: options.slice(0, 3).map((o) => ({ id: o.option_id, label: o.title })),
    });
  };

  if (APPROVE_ONLY.test(text)) return approveWithDefault();
  if (REJECT_ONLY.test(text)) {
    const skip = options.find((o) => !o.action_draft);
    return skip ? { kind: "reject", option: skip } : { kind: "reject" };
  }

  if (decision.kind === "choose_option") {
    const ord = parseOrdinal(text);
    if (ord !== undefined) {
      const idx = ord === -1 ? options.length - 1 : ord;
      const o = options[idx];
      if (o) return asOutcome(o);
    }
    if (/\b(default|recommended|your pick|you choose|you pick|your choice|whichever|best one)\b/.test(text)) {
      const def = options.find((o) => o.option_id === decision.default_option_id) ?? options[0];
      if (def) return asOutcome(def);
    }
    if (/\b(cheapest|cheaper|lowest price|least expensive|most affordable)\b/.test(text)) {
      const o = minBy(options, (x) => x.price?.amount_minor, 1);
      if (o) return asOutcome(o);
    }
    if (/\b(most expensive|priciest|premium|highest price)\b/.test(text)) {
      const o = minBy(options, (x) => x.price?.amount_minor, -1);
      if (o) return asOutcome(o);
    }
  }

  const fuzzyText = text.replace(LEADING_APPROVE, "").trim();
  const result = resolveReference(fuzzyText || text, optionCandidates(options), { now, minScore: 1 });
  if (result.kind === "match") return asOutcome(result.item);
  if (result.kind === "ambiguous") throw ambiguity(result.candidates);

  if (LEADING_REJECT.test(text)) return { kind: "reject" };
  if (LEADING_APPROVE.test(text) && decision.kind === "approve_action") return approveWithDefault();

  if (decision.kind === "approve_action") {
    throw new ButlerError("INVALID_INPUT", "I didn't catch that. Should I go ahead, or skip it?");
  }
  throw new ButlerError("NOT_FOUND", `I didn't catch which one. Was it ${listSpoken(options)}?`, {
    candidates: toCandidates(optionCandidates(options)),
  });
}
