import { describe, expect, it } from "vitest";
import { fitSpoken, lintSpoken, splitSentences } from "../src/lib/lintSpoken.js";

describe("lintSpoken (contracts §15)", () => {
  it("accepts the contract's example summaries", () => {
    for (const ok of [
      "Got it, six guests Friday at 7 PM. I'll handle invites, the calendar and drinks, and I'll check with you on cleaning.",
      "Invites went to all six, Friday's on the calendar, and I bought drinks for 42 dollars. One thing for you: which cleaner should I book?",
      "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it.",
      "From now on, I'll ask before buying drinks. Should I make that a rule?",
      "Done. It'll take effect in a moment.",
      "I booked it for 42 dollars 50 at 2:04 PM.",
    ]) {
      expect(lintSpoken(ok), ok).toEqual([]);
    }
  });

  it("flags empty text", () => {
    expect(lintSpoken("")).toContain("empty spoken text");
    expect(lintSpoken("   ")).toContain("empty spoken text");
    expect(lintSpoken(undefined)).toContain("empty spoken text");
  });

  it("flags more than two sentences", () => {
    expect(lintSpoken("One. Two. Three.")).toEqual(expect.arrayContaining([expect.stringContaining("more than 2 sentences")]));
  });

  it("does not treat decimals or clock times as sentence ends", () => {
    expect(splitSentences("It cost 4.8 stars at 2:04 PM. Fine.")).toHaveLength(2);
  });

  it("flags more than 35 words", () => {
    const long = Array.from({ length: 40 }, () => "word").join(" ") + ".";
    expect(lintSpoken(long)).toEqual(expect.arrayContaining([expect.stringContaining("more than 35 words")]));
  });

  it("allows at most one question and only at the end", () => {
    expect(lintSpoken("Do you want it? Or not?")).toContain("more than one question");
    expect(lintSpoken("Should I? I think so.")).toContain("question is not at the end");
    expect(lintSpoken("Sure. Should I go?")).toEqual([]);
  });

  it("flags markdown, bullets, pipes, emoji and line breaks", () => {
    expect(lintSpoken("**Bold** move.")).toContain("contains markdown or bullets");
    expect(lintSpoken("- item one")).toContain("contains markdown or bullets");
    expect(lintSpoken("See `code` here.")).toContain("contains markdown or bullets");
    expect(lintSpoken("a | b")).toContain("contains a pipe");
    expect(lintSpoken("Done 🎉")).toContain("contains emoji");
    expect(lintSpoken("line one\nline two")).toContain("contains a line break");
  });

  it("flags URLs, ids, tool names and JSON", () => {
    expect(lintSpoken("Open https://example.com now.")).toContain("contains a URL");
    expect(lintSpoken("Visit butler.com today.")).toContain("contains a URL");
    expect(lintSpoken("I used plan_01HZZZZZZZZZ.")).toContain("contains an id or tool name");
    expect(lintSpoken("I used Supplies___checkout.")).toContain("contains an id or tool name");
    expect(lintSpoken("It was 01ARZ3NDEKTSV4RRFFQ69G5FAV done.")).toContain("contains an id or tool name");
    expect(lintSpoken('Result {"ok": true}')).toContain("contains JSON");
  });

  it("flags money that is not spoken in words-friendly numbers", () => {
    expect(lintSpoken("It cost $42.50.")).toContain('money must be spoken ("42 dollars"), not "$42"');
    expect(lintSpoken("It cost 42.50 dollars.")).toContain('money must be spoken as "42 dollars 50", not decimals');
    expect(lintSpoken("It cost 42 USD.")).toEqual(expect.arrayContaining([expect.stringContaining("money")]));
  });

  it("flags machine time formats", () => {
    expect(lintSpoken("At 2026-10-16T19:00:00-04:00 it starts.")).toContain("contains an ISO date");
    expect(lintSpoken("It starts at 19:00.")).toContain("contains a 24-hour time");
    expect(lintSpoken("It starts at 7pm.")).toContain('times must read "7 PM", not "7pm"');
  });

  it("fitSpoken trims to a lint-clean length", () => {
    const out = fitSpoken("One sentence here. Second sentence here. Third sentence here.");
    expect(lintSpoken(out)).toEqual([]);
    const long = fitSpoken(Array.from({ length: 50 }, () => "word").join(" ") + ".");
    expect(lintSpoken(long)).toEqual([]);
  });
});
