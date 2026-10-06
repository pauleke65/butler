/** Small helpers for composing spoken text that satisfies contracts §15. */
import type { Rule } from "@butler/contracts";

export function stripEndPunct(s: string): string {
  return s.trim().replace(/[.!?…]+$/, "");
}

/** Lower-case the first letter unless the word is an acronym or proper-looking ("OK", "BrightHome" keeps its inner caps). */
export function lowerFirst(s: string): string {
  if (!s) return s;
  const second = s.charAt(1);
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return s; // "OK", "AI"
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function upperFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 others" (at most 3 names, contracts §15). */
export function joinNames(names: string[], max = 3): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length <= max) return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  const rest = unique.length - max;
  return `${unique.slice(0, max).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/** Rule text ("Ask me before buying drinks.") → first-person promise ("I'll ask before buying drinks"). */
export function ruleAsPromise(text: string): string {
  const t = stripEndPunct(text);
  const rewrites: Array<[RegExp, string]> = [
    [/^always ask me before\s+/i, "I'll always ask before "],
    [/^ask me before\s+/i, "I'll ask before "],
    [/^ask me first before\s+/i, "I'll ask before "],
    [/^never\s+/i, "I'll never "],
    [/^don'?t\s+/i, "I won't "],
    [/^do not\s+/i, "I won't "],
  ];
  for (const [re, to] of rewrites) if (re.test(t)) return t.replace(re, to).replace(/\bmy\b/gi, "your").replace(/\bme\b/gi, "you");
  return `follow this rule: ${lowerFirst(t)}`;
}

export function ruleHeadline(rule: Rule): string {
  return stripEndPunct(rule.text);
}
