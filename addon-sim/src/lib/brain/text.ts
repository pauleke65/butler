/** Small text helpers shared by the offline router. */

export const STOPWORDS = new Set(
  "a an the and or but of to in on at for with from by as is are was were be been it its this that these those i me my you your we our they them he she his her do does did done can could would should will shall may might must have has had not no yes so if then than too very just about into over after before when what which who whom whose how why there here some any all each more most other such only own same also up out off again further once".split(
    " ",
  ),
);

/** Crude English stemmer: enough to make "disagrees"/"disagree", "needs"/"need", "travelling"/"travel" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, "");
  if (w.length <= 3) return w;
  w = w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m));
  w = w.replace(/(.)\1$/, "$1"); // travell -> travel, stopp -> stop
  return w;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/[’]/g, "'").match(/[a-z0-9']+/g) ?? []).map((t) => t.replace(/^'+|'+$/g, "")).filter(Boolean);
}

export function contentStems(text: string): string[] {
  return tokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

export function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s.!?]+$/g, "").trim();
}

export const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|one)\b/i, 0],
  [/\b(second|2nd|two)\b/i, 1],
  [/\b(third|3rd|three)\b/i, 2],
  [/\b(fourth|4th|four)\b/i, 3],
  [/\b(fifth|5th|five)\b/i, 4],
  [/\b(last)\b/i, -1],
];

export function ordinalIndex(text: string): number | undefined {
  for (const [re, i] of ORDINALS) if (re.test(text)) return i;
  return undefined;
}
