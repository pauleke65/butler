/**
 * Fast needs pass (contracts §12.1, ticket M-3).
 *
 * `NeedsPass` is the injectable interface. `KeywordNeedsPass` is the offline implementation and also the
 * fallback for the Bedrock implementation (bedrockNeedsPass.ts). Dates are always resolved locally with
 * chrono-node in the household timezone so both implementations agree and results are deterministic.
 */
import * as chrono from "chrono-node";
import type { Capability, Contact, SituationKind } from "@butler/contracts";
import {
  addDays,
  isoInTz,
  spokenRange,
  tzOffsetMinutes,
  wallClock,
  weekdayName,
  zonedToInstant,
} from "./time.js";

export interface NeedsPassInput {
  situation: string;
  when?: string | undefined;
  timezone: string;
  now: Date;
  contacts: Contact[];
}

export interface NeedSketch {
  label: string;
  capability: Capability;
}

export interface NeedsPassResult {
  kind: SituationKind;
  title: string;
  starts_at?: string;
  ends_at?: string;
  needs: NeedSketch[];
  source: "keywords" | "bedrock";
}

export interface NeedsPass {
  run(input: NeedsPassInput): Promise<NeedsPassResult>;
}

// ───────────────────────────── text analysis ─────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a_couple: 2, a_few: 3,
};

const HOSTING_PATTERNS: RegExp[] = [
  /\b(coming over|come over|comes over|coming round|come round|dropping by|popping over)\b/i,
  /\b(guests?|visitors?|visiting|visit)\b/i,
  /\b(host(ing)?|hosting)\b/i,
  /\b(dinner|supper|lunch|brunch|party|barbecue|bbq|get-?together|birthday|movie night|game night)\b/i,
  /\b(friends|crew|colleagues|neighbou?rs|relatives|family)\b.*\b(coming|arriving|visiting|over|staying)\b/i,
  /\b(invite|having .{1,30} (over|round))\b/i,
];
const AWAY_PATTERNS: RegExp[] = [
  /\b(travell?ing|travel|away|out of town|trip|vacation|holiday|flying|be gone|going to be gone|leaving town|business trip)\b/i,
  /\b(won'?t be (home|here)|not be (home|here)|away from home)\b/i,
];
const LOW_PATTERNS: RegExp[] = [
  /\b(running (low|out)|ran out|out of|low on|almost out|nearly out|used up|need more|running short)\b/i,
];

function score(patterns: RegExp[], text: string): number {
  return patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
}

export function classifyKind(text: string): SituationKind {
  const hosting = score(HOSTING_PATTERNS, text);
  const away = score(AWAY_PATTERNS, text);
  const low = score(LOW_PATTERNS, text);
  const max = Math.max(hosting, away, low);
  if (max === 0) return "other";
  // Explicit travel words beat hosting words on a tie ("I'm away, my friends are staying").
  if (away === max) return "away";
  if (hosting === max) return "hosting";
  return "running_low";
}

function numberFrom(token: string): number | undefined {
  const t = token.toLowerCase().replace(/\s+/g, "_");
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t];
}

const GROUP_NOUN = "(?:people|guests?|friends?|folks|colleagues|coworkers|co-workers|relatives|mates|neighbou?rs|adults|kids|children|of us)";

/** Explicit headcount: "six friends", "6 people", "a couple of friends". */
export function extractHeadcount(text: string): number | undefined {
  const re = new RegExp(`\\b(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple|a few)\\s+(?:of\\s+)?(?:my\\s+|our\\s+|the\\s+)?(?:\\w+\\s+){0,2}?${GROUP_NOUN}\\b`, "i");
  const m = re.exec(text);
  if (!m) return undefined;
  const n = numberFrom(m[1] as string);
  if (n === undefined) return undefined;
  if (/of us\b/i.test(m[0])) return Math.max(1, n - 1);
  return n;
}

function tagPhrases(tag: string): string[] {
  const spaced = tag.replace(/[-_]/g, " ");
  return [spaced, tag];
}

/** Count contacts referred to by group tag ("dinner crew") or by first name. */
export function groupGuestCount(text: string, contacts: Contact[]): number | undefined {
  const lower = text.toLowerCase();
  const ids = new Set<string>();
  const tags = new Set<string>();
  for (const c of contacts) for (const t of c.tags ?? []) tags.add(t);
  for (const tag of tags) {
    if (tagPhrases(tag).some((p) => lower.includes(p.toLowerCase()))) {
      for (const c of contacts) if (c.tags?.includes(tag)) ids.add(c.contact_id);
    }
  }
  for (const c of contacts) {
    const re = new RegExp(`\\b${c.first_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) ids.add(c.contact_id);
  }
  return ids.size > 0 ? ids.size : undefined;
}

export function guestCount(text: string, contacts: Contact[]): number | undefined {
  return extractHeadcount(text) ?? groupGuestCount(text, contacts);
}

function mealWord(text: string): "dinner" | "lunch" | "brunch" | "party" | "get-together" {
  if (/\bbrunch\b/i.test(text)) return "brunch";
  if (/\blunch\b/i.test(text)) return "lunch";
  if (/\b(party|birthday)\b/i.test(text)) return "party";
  if (/\b(dinner|supper|crew)\b/i.test(text)) return "dinner";
  return "get-together";
}

export function extractLowItem(text: string): string | undefined {
  const m = /(?:running (?:low|out)\s+(?:on|of)|out of|low on|ran out of|almost out of|nearly out of|need more|running short (?:on|of))\s+([a-z][a-z ,&'-]{1,40}?)(?=[.,;!?]|\s+(?:and then|but|so|because|before|again)\b|$)/i.exec(text);
  const item = m?.[1]?.trim().replace(/^(the|my|our|some)\s+/i, "");
  return item && item.length >= 2 ? item : undefined;
}

// ───────────────────────────── dates ─────────────────────────────

export interface ResolvedTimes {
  starts_at?: string;
  ends_at?: string;
  startDate?: Date;
  endDate?: Date;
  /** Weekday/date text for titles. */
  hadTime: boolean;
}

const TIME_OF_DAY_WORDS = /\b(tonight|evening|night|dinner|supper|party|drinks)\b/i;
const MORNING_WORDS = /\b(morning|breakfast|brunch|am|a\.m\.)\b/i;

function fixMeridiem(hour: number, text: string): number {
  if (hour >= 12 || hour === 0) return hour;
  if (MORNING_WORDS.test(text)) return hour;
  if (hour >= 1 && hour <= 8) return hour + 12; // "at 7" means 7 PM; nobody hosts at 7 AM
  if (hour >= 9 && hour <= 11 && TIME_OF_DAY_WORDS.test(text)) return hour + 12;
  return hour;
}

const DEFAULT_HOUR: Record<SituationKind, number> = { hosting: 19, away: 0, running_low: 9, other: 9 };

export function resolveTimes(input: NeedsPassInput, kind: SituationKind): ResolvedTimes {
  const tz = input.timezone;
  const ref = { instant: input.now, timezone: tzOffsetMinutes(input.now, tz) };
  const candidates = [input.when, input.situation].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  for (const text of candidates) {
    const parsed = chrono.parse(text, ref, { forwardDate: true });
    const r = parsed[0];
    if (!r) continue;

    const certainHour = r.start.isCertain("hour");
    let hour: number;
    let minute = 0;
    if (certainHour) {
      hour = r.start.get("hour") ?? DEFAULT_HOUR[kind];
      minute = r.start.get("minute") ?? 0;
      if (!r.start.isCertain("meridiem")) hour = fixMeridiem(hour, `${text} ${input.situation}`);
    } else if (/\b(tonight|evening|night|morning|afternoon|noon|lunchtime)\b/i.test(text)) {
      hour = r.start.get("hour") ?? DEFAULT_HOUR[kind];
    } else {
      hour = DEFAULT_HOUR[kind];
    }
    const startDate = zonedToInstant(
      { year: r.start.get("year") ?? 0, month: r.start.get("month") ?? 1, day: r.start.get("day") ?? 1, hour, minute },
      tz,
    );

    let endDate: Date | undefined;
    if (r.end) {
      const endCertainHour = r.end.isCertain("hour");
      const endHour = endCertainHour ? fixMeridiem(r.end.get("hour") ?? 23, text) : 23;
      endDate = zonedToInstant(
        {
          year: r.end.get("year") ?? 0,
          month: r.end.get("month") ?? 1,
          day: r.end.get("day") ?? 1,
          hour: endCertainHour ? endHour : 23,
          minute: endCertainHour ? (r.end.get("minute") ?? 0) : 59,
        },
        tz,
      );
    } else if (kind === "hosting") {
      endDate = new Date(startDate.getTime() + 3 * 3600_000);
    } else if (kind === "away") {
      // single day away: until the end of that day
      const w = wallClock(startDate, tz);
      endDate = zonedToInstant({ year: w.year, month: w.month, day: w.day, hour: 23, minute: 59 }, tz);
    }
    return {
      starts_at: isoInTz(startDate, tz),
      ...(endDate ? { ends_at: isoInTz(endDate, tz) } : {}),
      startDate,
      ...(endDate ? { endDate } : {}),
      hadTime: certainHour,
    };
  }
  return { hadTime: false };
}

// ───────────────────────────── titles and needs ─────────────────────────────

function short(label: string, max = 40): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clockLabel(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  const suffix = w.hour >= 12 ? "PM" : "AM";
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return w.minute === 0 ? `${h} ${suffix}` : `${h}:${String(w.minute).padStart(2, "0")} ${suffix}`;
}

function dayLabel(date: Date, now: Date, tz: string): string {
  const diff = Math.round(
    (Date.UTC(wallClock(date, tz).year, wallClock(date, tz).month - 1, wallClock(date, tz).day) -
      Date.UTC(wallClock(now, tz).year, wallClock(now, tz).month - 1, wallClock(now, tz).day)) /
      86_400_000,
  );
  // Titles persist, so they use weekday names rather than "tomorrow".
  if (diff >= 0 && diff < 7) return weekdayName(wallClock(date, tz).weekday);
  const w = wallClock(date, tz);
  return `${w.month}/${w.day}`;
}

function parentsMentioned(text: string): boolean {
  return /\b(parents|mum|mom|dad|mother|father|in-?laws)\b/i.test(text);
}
function someoneStaying(text: string): boolean {
  return /\b(staying|house-?sit(ter|ting)?|looking after|watching the (house|place|cat|dog))\b/i.test(text);
}

export function buildKeywordResult(input: NeedsPassInput, kindOverride?: SituationKind): NeedsPassResult {
  const text = input.situation;
  const kind = kindOverride ?? classifyKind(`${text} ${input.when ?? ""}`);
  const times = resolveTimes(input, kind);
  const tz = input.timezone;
  const base = { ...(times.starts_at ? { starts_at: times.starts_at } : {}), ...(times.ends_at ? { ends_at: times.ends_at } : {}) };

  if (kind === "hosting") {
    const n = guestCount(text, input.contacts);
    const meal = mealWord(text);
    const when = times.startDate ? `, ${dayLabel(times.startDate, input.now, tz)}${` ${clockLabel(times.startDate, tz)}`}` : "";
    const title = short(n ? `${titleCase(meal)} for ${n}${when}` : `${titleCase(meal)} at home${when}`, 60);
    return {
      kind,
      title,
      ...base,
      needs: [
        { label: n ? `Invite ${n} guests` : "Invite your guests", capability: "messages" },
        { label: short(`Add ${meal === "get-together" ? "it" : meal} to your calendar`), capability: "calendar" },
        { label: "Order food and drinks", capability: "supplies" },
        { label: "Book a cleaner", capability: "services" },
      ],
      source: "keywords",
    };
  }

  if (kind === "away") {
    const parents = parentsMentioned(text);
    const staying = someoneStaying(text);
    let range = "";
    if (times.startDate && times.endDate) {
      // "Away, Thursday to Sunday": weekday names when close, like the spoken reply
      const r = spokenRange(times.startDate, times.endDate, input.now, tz);
      range = `, ${r.charAt(0).toUpperCase()}${r.slice(1)}`;
    } else if (times.startDate) range = `, ${dayLabel(times.startDate, input.now, tz)}`;
    return {
      kind,
      title: short(`Away${range}`, 60),
      ...base,
      needs: [
        { label: parents ? "Tell your parents the plan" : "Let people know you're away", capability: "messages" },
        { label: "Block your calendar", capability: "calendar" },
        {
          label: parents ? "Stock drinks for your parents" : staying ? "Stock drinks for house guests" : "Pause or redirect deliveries",
          capability: "supplies",
        },
      ],
      source: "keywords",
    };
  }

  if (kind === "running_low") {
    const item = extractLowItem(text);
    return {
      kind,
      title: short(item ? `Restock ${item}` : "Restock supplies", 60),
      ...base,
      needs: [{ label: short(item ? `Reorder ${item}` : "Check and reorder supplies"), capability: "supplies" }],
      source: "keywords",
    };
  }

  return {
    kind: "other",
    title: short(titleCase(text.replace(/[.!?]+$/, "")), 60),
    ...base,
    needs: [
      { label: "Check your calendar", capability: "calendar" },
      { label: "Work out what you need", capability: "context" },
    ],
    source: "keywords",
  };
}

export class KeywordNeedsPass implements NeedsPass {
  async run(input: NeedsPassInput): Promise<NeedsPassResult> {
    return buildKeywordResult(input);
  }
}

/** Ensure a result honours §12.1 limits (label ≤ 40 chars, 1–6 needs). */
export function normalizeNeeds(needs: NeedSketch[]): NeedSketch[] {
  return needs.slice(0, 6).map((n) => ({ ...n, label: short(n.label.trim()) }));
}

export { addDays };
