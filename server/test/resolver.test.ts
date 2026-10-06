import { describe, expect, it } from "vitest";
import { resolveChoice } from "../src/lib/choice.js";
import { ButlerError } from "../src/lib/errors.js";
import {
  isPronounReference,
  optionCandidates,
  parseOrdinal,
  receiptCandidates,
  resolveReference,
  ruleCandidates,
  stem,
} from "../src/lib/resolver.js";
import { cleaningDecision, drinksDecision, fixtures, NOW, receiptByTitle } from "./helpers.js";

const now = NOW.getTime();
const cands = () => receiptCandidates(fixtures.receipts, fixtures.contacts, NOW, "America/New_York");
/** The ledger as it stood at demo scene 4, before the away plan's held drinks purchase existed. */
const sceneFour = () =>
  receiptCandidates(
    fixtures.receipts.filter((r) => r.plan_id !== fixtures.planAway.plan_id),
    fixtures.contacts,
    NOW,
    "America/New_York",
  );

describe("reference resolver (receipts)", () => {
  it("resolves 'the drinks' to the most recent drinks purchase, not the 3-week-old one", () => {
    const r = resolveReference("the drinks", sceneFour(), { now });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.item.title).toBe("Bought drinks for 7");
  });

  it("a held and a bought drinks receipt from the same day are ambiguous (<= 3 candidates)", () => {
    const r = resolveReference("the drinks", cands(), { now });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const titles = r.candidates.map((c) => c.item.title);
      expect(titles).toEqual(expect.arrayContaining(["Bought drinks for 7", "Held a drinks purchase"]));
      expect(r.candidates.length).toBeLessThanOrEqual(3);
    }
  });

  it("resolves the email to Tolu by tool word + recipient name", () => {
    const r = resolveReference("the email to Tolu", cands(), { now });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.item.title).toBe("Invited 6 guests");
  });

  it("'that' means the most recent receipt", () => {
    const r = resolveReference("that", cands(), { now });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.item.action_id).toBe([...fixtures.receipts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.action_id);
    expect(isPronounReference("that one")).toBe(true);
    expect(isPronounReference("the most recent one")).toBe(true);
    expect(isPronounReference("the drinks")).toBe(false);
  });

  it("matches by category, merchant, need label, tool synonyms and sku words", () => {
    expect(resolveReference("the cleaner", cands(), { now })).toMatchObject({ kind: "match", item: { title: "Booked BrightHome" } });
    expect(resolveReference("the snack platter", cands(), { now })).toMatchObject({ kind: "match", item: { title: "Bought a snack platter" } });
    expect(resolveReference("the dinner on my calendar", cands(), { now })).toMatchObject({ kind: "match", item: { title: "Added dinner to your calendar" } });
    expect(resolveReference("dishwasher tablets", cands(), { now })).toMatchObject({ kind: "match", item: { status: "failed" } });
  });

  it("returns none when nothing matches", () => {
    expect(resolveReference("the helicopter", cands(), { now }).kind).toBe("none");
    expect(resolveReference("anything", [], { now }).kind).toBe("none");
  });

  it("ordinals pick by recency order", () => {
    expect(parseOrdinal("the second one")).toBe(1);
    expect(parseOrdinal("option 3")).toBe(2);
    expect(parseOrdinal("the last one")).toBe(-1);
    expect(parseOrdinal("the drinks")).toBeUndefined();
    const first = resolveReference("the first one", cands(), { now });
    expect(first.kind).toBe("match");
  });

  it("stems plurals", () => {
    expect(stem("drinks")).toBe("drink");
    expect(stem("batteries")).toBe("battery");
    expect(stem("boxes")).toBe("box");
    expect(stem("glass")).toBe("glass");
  });
});

describe("reference resolver (rules)", () => {
  it("finds the spending limit and the drinks rule from spoken words", () => {
    const cs = ruleCandidates(fixtures.rules);
    expect(resolveReference("the spending limit", cs, { now })).toMatchObject({ kind: "match", item: { rule_id: "rule_default_spend" } });
    expect(resolveReference("the drinks rule", cs, { now })).toMatchObject({ kind: "match", item: { template: "ask_category" } });
    expect(resolveReference("refunds", cs, { now })).toMatchObject({ kind: "match", item: { rule_id: "rule_default_refunds" } });
  });
});

describe("choice resolver (answer_decision)", () => {
  const dec = cleaningDecision();
  const [sparkle, bright, tidy] = dec.options;
  const choose = (c: string) => resolveChoice(dec, c, now);

  it("option id, ordinals and titles", () => {
    expect(choose(bright!.option_id)).toMatchObject({ kind: "option", option: { title: "BrightHome" } });
    expect(choose("the second one")).toMatchObject({ kind: "option", option: { title: "BrightHome" } });
    expect(choose("first")).toMatchObject({ kind: "option", option: { title: "Sparkle Cleaners" } });
    expect(choose("the last one")).toMatchObject({ kind: "option", option: { title: "TidyUp Co" } });
    expect(choose("option 3")).toMatchObject({ kind: "option", option: { title: "TidyUp Co" } });
    expect(choose("Sparkle")).toMatchObject({ kind: "option", option: { title: "Sparkle Cleaners" } });
    expect(choose("Book BrightHome.")).toMatchObject({ kind: "option", option: { title: "BrightHome" } });
    expect(choose("go with tidy up")).toMatchObject({ kind: "option", option: { title: "TidyUp Co" } });
  });

  it("price and default words", () => {
    expect(choose("the cheapest")).toMatchObject({ option: { title: "TidyUp Co" } });
    expect(choose("the most expensive one")).toMatchObject({ option: { title: "BrightHome" } });
    expect(choose("whichever you recommend")).toMatchObject({ option: { title: "BrightHome" } });
    void sparkle; void tidy;
  });

  it("approve uses the default option for choose_option, the only option for approve_action", () => {
    expect(choose("yes")).toMatchObject({ kind: "option", option: { title: "BrightHome" } });
    expect(resolveChoice(drinksDecision(), "approve", now)).toMatchObject({ kind: "option" });
    expect(resolveChoice(drinksDecision(), "Yes, go ahead", now)).toMatchObject({ kind: "option" });
  });

  it("reject words and skip", () => {
    expect(choose("no")).toEqual({ kind: "reject" });
    expect(choose("reject")).toEqual({ kind: "reject" });
    expect(choose("skip it")).toEqual({ kind: "reject" });
    expect(resolveChoice(drinksDecision(), "no thanks", now)).toEqual({ kind: "reject" });
    expect(resolveChoice(drinksDecision(), "don't buy it", now)).toEqual({ kind: "reject" });
  });

  it("an option without an action draft counts as skip", () => {
    const withSkip = { ...dec, options: [...dec.options, { option_id: "opt_skip", title: "Skip cleaning", tradeoff: "I'll sort it myself" }] };
    expect(resolveChoice(withSkip, "skip cleaning", now)).toMatchObject({ kind: "reject", option: { option_id: "opt_skip" } });
    expect(resolveChoice(withSkip, "opt_skip", now)).toMatchObject({ kind: "reject" });
  });

  it("no match -> NOT_FOUND with the options as candidates; ties -> AMBIGUOUS", () => {
    try {
      choose("the purple one");
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ButlerError);
      expect((e as ButlerError).code).toBe("NOT_FOUND");
      expect((e as ButlerError).candidates).toHaveLength(3);
    }
    const twin = { ...dec, options: [{ ...dec.options[0]!, option_id: "a", title: "Sparkle Cleaners" }, { ...dec.options[0]!, option_id: "b", title: "Sparkle Cleaners Deluxe" }] };
    expect(() => resolveChoice(twin, "Sparkle", now)).toThrowError(expect.objectContaining({ code: "AMBIGUOUS_REFERENCE" }));
  });

  it("garbage on an approval -> INVALID_INPUT", () => {
    expect(() => resolveChoice(drinksDecision(), "purple monkey", now)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("option candidates carry searchable text", () => {
    expect(optionCandidates(dec.options)[1]?.label).toBe("BrightHome");
    void receiptByTitle;
  });
});
