/**
 * Reference resolver (ticket M-9): turns spoken references ("the drinks", "the email to Tolu", "that",
 * "the second one", "the spending limit") into one of a list of candidates, with a recency boost and
 * an AMBIGUOUS_REFERENCE outcome (<= 3 candidates) when several match about equally well.
 */
import type { Contact, DecisionOption, Receipt, Rule } from "@butler/contracts";
import { ButlerError, type Candidate } from "./errors.js";

export interface RefText {
  text: string;
  weight: number;
}

export interface RefCandidate<T> {
  item: T;
  id: string;
  label: string;
  texts: RefText[];
  /** Epoch ms used for the recency boost and for "that"/"the last one". */
  at?: number;
}

export type ResolveResult<T> =
  | { kind: "match"; item: T; candidate: RefCandidate<T> }
  | { kind: "ambiguous"; candidates: RefCandidate<T>[] }
  | { kind: "none" };

const STOPWORDS = new Set(
  "the a an my our your that this those these it its one ones of to for from on in at did do does you i me we what why how about please and or with by is are was were be been just also actually thing things stuff which when where who whom there here can could would should".split(" "),
);

export function stem(token: string): string {
  let t = token.toLowerCase();
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(sses|xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

const ORDINALS: Record<string, number> = {
  first: 0, "1st": 0, one: 0, second: 1, "2nd": 1, two: 1, third: 2, "3rd": 2, three: 2, fourth: 3, "4th": 3, four: 3, fifth: 4, "5th": 4, five: 4,
};

/** "the second one" / "option 2" → zero-based index; "last" → -1. */
export function parseOrdinal(reference: string): number | undefined {
  const lower = reference.toLowerCase();
  if (/\b(the )?last( one)?\b/.test(lower) && !/\blast (week|night|time)\b/.test(lower)) return -1;
  const m = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/.exec(lower);
  if (m) return ORDINALS[m[1] as string];
  const n = /\b(?:option|number|no\.?|#|choice|item)\s*(\d)\b/.exec(lower) ?? /^\s*(\d)\s*$/.exec(lower);
  if (n) return Number(n[1]) - 1;
  const w = /\b(?:option|number|choice)\s+(one|two|three|four|five)\b/.exec(lower);
  if (w) return ORDINALS[w[1] as string];
  if (/^(the )?(one|two|three|four|five)( one)?$/.test(lower.trim())) {
    const word = /(one|two|three|four|five)/.exec(lower)?.[1];
    if (word) return ORDINALS[word];
  }
  return undefined;
}

const PRONOUN_ONLY = /^(?:(?:that|this|it|the|last|latest|most recent|previous|recent|one|thing|action|purchase|booking|email|message|rule|just now|you just did|you did|just did)\s*)+$/;

export function isPronounReference(reference: string): boolean {
  const lower = reference.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (lower === "") return true;
  return PRONOUN_ONLY.test(lower);
}

function recency(at: number | undefined, now: number): number {
  if (at === undefined) return 0;
  const ageHours = Math.max(0, now - at) / 3_600_000;
  return 1 / (1 + ageHours / 24);
}

function scoreCandidate<T>(refTokens: string[], c: RefCandidate<T>): number {
  const bags = c.texts.map((t) => ({ tokens: new Set(contentTokens(t.text)), weight: t.weight }));
  let total = 0;
  for (const rt of refTokens) {
    let best = 0;
    for (const bag of bags) {
      if (bag.tokens.has(rt)) best = Math.max(best, bag.weight);
      else if (rt.length >= 4) {
        for (const tok of bag.tokens) {
          if (tok.length >= 4 && (tok.startsWith(rt) || rt.startsWith(tok))) best = Math.max(best, bag.weight * 0.7);
        }
      }
    }
    total += best;
  }
  return total;
}

export interface ResolveOptions {
  now: number;
  maxCandidates?: number;
  /** Minimum summed token weight to count as a match. */
  minScore?: number;
  /** Second place within this fraction of the best is "about equally good" (ambiguous). */
  ambiguityRatio?: number;
}

export function resolveReference<T>(reference: string, cands: RefCandidate<T>[], opts: ResolveOptions): ResolveResult<T> {
  if (cands.length === 0) return { kind: "none" };
  const max = opts.maxCandidates ?? 3;
  const byRecency = [...cands].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const ordinal = parseOrdinal(reference);
  if (ordinal !== undefined) {
    const idx = ordinal === -1 ? byRecency.length - 1 : ordinal;
    const c = byRecency[idx];
    if (c && /\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|option|number|choice|#)/i.test(reference)) {
      return { kind: "match", item: c.item, candidate: c };
    }
  }

  if (isPronounReference(reference)) {
    const c = byRecency[0] as RefCandidate<T>;
    return { kind: "match", item: c.item, candidate: c };
  }

  const refTokens = contentTokens(reference);
  if (refTokens.length === 0) {
    const c = byRecency[0] as RefCandidate<T>;
    return { kind: "match", item: c.item, candidate: c };
  }

  const scored = cands
    .map((c) => {
      const base = scoreCandidate(refTokens, c);
      return { c, base, final: base * (1 + 0.6 * recency(c.at, opts.now)) };
    })
    .filter((s) => s.base >= (opts.minScore ?? 1))
    .sort((a, b) => b.final - a.final || (b.c.at ?? 0) - (a.c.at ?? 0));

  const best = scored[0];
  if (!best) return { kind: "none" };
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.final >= best.final * (opts.ambiguityRatio ?? 0.85)) {
    const close = scored.filter((s) => s.final >= best.final * (opts.ambiguityRatio ?? 0.85)).slice(0, max);
    return { kind: "ambiguous", candidates: close.map((s) => s.c) };
  }
  return { kind: "match", item: best.c.item, candidate: best.c };
}

/** Throw NOT_FOUND / AMBIGUOUS_REFERENCE unless there is a single match. */
export function requireMatch<T>(result: ResolveResult<T>, spokenNotFound?: string): RefCandidate<T> {
  if (result.kind === "match") return result.candidate;
  if (result.kind === "ambiguous") throw ambiguity(result.candidates);
  throw new ButlerError("NOT_FOUND", spokenNotFound);
}

export function toCandidates<T>(cands: RefCandidate<T>[]): Candidate[] {
  return cands.slice(0, 3).map((c) => ({ id: c.id, label: c.label }));
}

export function ambiguity<T>(cands: RefCandidate<T>[]): ButlerError {
  const labels = cands.slice(0, 3).map((c) => c.label);
  const spoken =
    labels.length === 2
      ? `Did you mean ${labels[0]} or ${labels[1]}?`
      : `Did you mean ${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}?`;
  return new ButlerError("AMBIGUOUS_REFERENCE", spoken, { candidates: toCandidates(cands) });
}

// ───────────────────────────── candidate builders ─────────────────────────────

const TOOL_WORDS: Record<string, string> = {
  Messages___send_email: "email mail message send sent invite invitation note",
  Calendar___create_event: "calendar event added schedule scheduled invite entry",
  Calendar___update_event: "calendar event changed update moved reschedule",
  Calendar___delete_event: "calendar event deleted removed cancel",
  Supplies___checkout: "buy bought purchase purchased order ordered payment shopping spend spent",
  Supplies___refund: "refund refunded return money back",
  Services___book_service: "book booked booking appointment service cleaner cleaning provider",
  Services___cancel_booking: "cancel cancelled booking",
  Supplies___search_products: "search products look",
  Services___search_providers: "search providers look",
  Calendar___list_events: "calendar events list check",
  Context___get_weather: "weather forecast",
};

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function receiptLabel(r: Receipt, now: Date, timezone = "America/New_York"): string {
  const created = new Date(r.created_at);
  const day = Number.isNaN(created.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(created);
  void now;
  return day ? `${r.title}, ${day}` : r.title;
}

export function receiptCandidates(receipts: Receipt[], contacts: Contact[], now: Date, timezone?: string): RefCandidate<Receipt>[] {
  const nameById = new Map(contacts.map((c) => [c.contact_id, c]));
  return receipts.map((r) => {
    const args = r.action.args;
    const recipients: string[] = [];
    const ids = args["recipient_contact_ids"];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        const c = typeof id === "string" ? nameById.get(id) : undefined;
        if (c) recipients.push(c.name, c.first_name);
      }
    }
    const attendees = args["attendee_contact_ids"];
    if (Array.isArray(attendees)) {
      for (const id of attendees) {
        const c = typeof id === "string" ? nameById.get(id) : undefined;
        if (c) recipients.push(c.name);
      }
    }
    const items: string[] = [];
    const argItems = args["items"];
    if (Array.isArray(argItems)) {
      for (const it of argItems) {
        if (it && typeof it === "object") {
          const o = it as Record<string, unknown>;
          if (typeof o["name"] === "string") items.push(o["name"]);
          if (typeof o["sku"] === "string") items.push(o["sku"].replace(/[-_]/g, " "));
        }
      }
    }
    const resultItems = r.result?.["items"];
    if (Array.isArray(resultItems)) {
      for (const it of resultItems) if (it && typeof it === "object" && typeof (it as Record<string, unknown>)["name"] === "string") items.push((it as Record<string, string>)["name"] as string);
    }
    return {
      item: r,
      id: r.action_id,
      label: receiptLabel(r, now, timezone),
      at: Date.parse(r.created_at) || undefined,
      texts: [
        { text: r.title, weight: 3 },
        { text: r.need_label ?? "", weight: 2 },
        { text: recipients.join(" "), weight: 2.5 },
        { text: items.join(" "), weight: 2 },
        { text: [stringArg(args, "category"), stringArg(args, "service_type"), stringArg(args, "merchant"), stringArg(args, "recipient_email")].filter(Boolean).join(" "), weight: 2 },
        { text: stringArg(args, "subject") ?? stringArg(args, "title") ?? "", weight: 1.5 },
        { text: TOOL_WORDS[r.action.tool] ?? "", weight: 1.5 },
        { text: r.reasons.join(" "), weight: 0.5 },
        { text: r.situation ?? "", weight: 0.4 },
      ],
    } satisfies RefCandidate<Receipt>;
  });
}

export function ruleCandidates(rules: Rule[]): RefCandidate<Rule>[] {
  return rules.map((r) => ({
    item: r,
    id: r.rule_id,
    label: r.text.replace(/[.!?]+$/, ""),
    at: Date.parse(r.created_at) || undefined,
    texts: [
      { text: r.text, weight: 3 },
      { text: Object.values(r.params).map((v) => (Array.isArray(v) ? v.join(" ") : String(v))).join(" "), weight: 2 },
      { text: r.template.replace(/_/g, " "), weight: 1.5 },
      {
        text:
          r.template === "spend_cap"
            ? "spending limit cap budget spend money"
            : r.template === "ask_non_contact"
              ? "message messaging contacts people strangers"
              : r.template === "protect_human_events"
                ? "calendar events"
                : r.template === "ask_category"
                  ? "category purchase buy"
                  : "",
        weight: 2,
      },
      { text: r.effect.replace("_", " "), weight: 0.5 },
    ],
  }));
}

export function optionCandidates(options: DecisionOption[]): RefCandidate<DecisionOption>[] {
  return options.map((o) => ({
    item: o,
    id: o.option_id,
    label: o.title,
    texts: [
      { text: o.title, weight: 3 },
      { text: o.subtitle ?? "", weight: 1.5 },
      { text: o.tradeoff, weight: 1 },
    ],
  }));
}
