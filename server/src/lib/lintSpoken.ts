/**
 * Spoken-text style lint (contracts §15, ticket M-19). Pure function returning human-readable violations.
 * Used in tests for every tool's `spoken_summary` and at runtime (WARN log, never blocks).
 */

const MAX_SENTENCES = 2;
const MAX_WORDS = 35;

/** Split into sentences: a terminator followed by whitespace + a capital/quote, or the end of the text. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  const chars = [...text.trim()];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    buf += ch;
    if (ch === "." || ch === "!" || ch === "?") {
      // consume repeated terminators
      while (chars[i + 1] === "." || chars[i + 1] === "!" || chars[i + 1] === "?") buf += chars[++i];
      const next = chars[i + 1];
      const after = chars[i + 2];
      const atEnd = next === undefined;
      const decimal = ch === "." && next !== undefined && /\d/.test(next);
      const boundary = atEnd || (/\s/.test(next as string) && (after === undefined || /[A-Z0-9"'(]/.test(after)));
      if (!decimal && boundary) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const URL_RE = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|org|net|io|dev|ai|app)\b/i;
const ID_PREFIX_RE = /\b(?:hh|mem|c|plan|need|dec|opt|act|rule|ord|bkg|evt|cor|prv|sku)_[A-Za-z0-9_]{2,}\b/;
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
const TOOL_NAME_RE = /\b[A-Z][a-z]+___[a-z_]+\b/;
const JSON_RE = /[{}]|"\s*:/;
const MARKDOWN_RE = /(\*\*|__|`|^#{1,6}\s|^\s*[-*•]\s|^\s*\d+\.\s|\]\(|\[[^\]]*\]\()/m;
const DOLLAR_SIGN_RE = /\$\s?\d|\d\s?(USD|usd)\b|\bUSD\b/;
const DECIMAL_MONEY_RE = /\b\d+\.\d{2}\s*(dollars?|bucks)\b/i;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}(T|\b)/;
const TWENTY_FOUR_H_RE = /\b([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?\b(?!\s*(AM|PM|am|pm))/;
const COMPACT_MERIDIEM_RE = /\b\d{1,2}(:\d{2})?(am|pm)\b/i;

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function lintSpoken(text: unknown): string[] {
  const violations: string[] = [];
  if (typeof text !== "string" || text.trim() === "") return ["empty spoken text"];

  const sentences = splitSentences(text);
  if (sentences.length > MAX_SENTENCES) violations.push(`more than ${MAX_SENTENCES} sentences (${sentences.length})`);

  const words = wordCount(text);
  if (words > MAX_WORDS) violations.push(`more than ${MAX_WORDS} words (${words})`);

  const questionCount = (text.match(/\?/g) ?? []).length;
  if (questionCount > 1) violations.push("more than one question");
  if (questionCount === 1 && !text.trim().endsWith("?")) violations.push("question is not at the end");

  if (MARKDOWN_RE.test(text)) violations.push("contains markdown or bullets");
  if (text.includes("|")) violations.push("contains a pipe");
  if (/\n/.test(text)) violations.push("contains a line break");
  if (EMOJI.test(text)) violations.push("contains emoji");
  if (URL_RE.test(text)) violations.push("contains a URL");
  if (ID_PREFIX_RE.test(text) || ULID_RE.test(text) || TOOL_NAME_RE.test(text)) violations.push("contains an id or tool name");
  if (JSON_RE.test(text)) violations.push("contains JSON");
  if (DOLLAR_SIGN_RE.test(text)) violations.push('money must be spoken ("42 dollars"), not "$42"');
  if (DECIMAL_MONEY_RE.test(text)) violations.push('money must be spoken as "42 dollars 50", not decimals');
  if (ISO_RE.test(text)) violations.push("contains an ISO date");
  if (TWENTY_FOUR_H_RE.test(text)) violations.push("contains a 24-hour time");
  if (COMPACT_MERIDIEM_RE.test(text)) violations.push('times must read "7 PM", not "7pm"');
  return violations;
}

/** Log WARN for violations and return the text unchanged (never blocks). */
export function checkSpoken(text: string, log: (violations: string[]) => void): string {
  const v = lintSpoken(text);
  if (v.length) log(v);
  return text;
}

/**
 * Shorten spoken text until it passes the length rules: drop trailing sentences beyond the limit and
 * trim words as a last resort. Used for composed text where an upstream string was too long.
 */
export function fitSpoken(text: string): string {
  const sentences = splitSentences(text).slice(0, MAX_SENTENCES);
  let out = sentences.join(" ");
  if (wordCount(out) > MAX_WORDS && sentences.length > 1) out = sentences[0] as string;
  if (wordCount(out) > MAX_WORDS) {
    out = `${out.split(/\s+/).slice(0, MAX_WORDS).join(" ").replace(/[,;:]$/, "")}.`;
  }
  return out;
}
