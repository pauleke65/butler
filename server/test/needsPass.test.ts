import { describe, expect, it, vi } from "vitest";
import { BedrockNeedsPass } from "../src/lib/bedrockNeedsPass.js";
import {
  buildKeywordResult,
  classifyKind,
  extractHeadcount,
  extractLowItem,
  groupGuestCount,
  KeywordNeedsPass,
  resolveTimes,
  type NeedsPassInput,
} from "../src/lib/needsPass.js";
import { fixtures, NOW } from "./helpers.js";

const NY = "America/New_York";
const input = (situation: string, when?: string): NeedsPassInput => ({ situation, when, timezone: NY, now: NOW, contacts: fixtures.contacts });

describe("keyword needs pass (offline fallback, §12.1)", () => {
  it("classifies the three situation kinds", () => {
    expect(classifyKind("Six friends from the dinner crew are coming over Friday at 7")).toBe("hosting");
    expect(classifyKind("I'm travelling Thursday to Sunday. My parents are staying at the house.")).toBe("away");
    expect(classifyKind("We're running low on dishwasher tablets")).toBe("running_low");
    expect(classifyKind("What's the weather like")).toBe("other");
  });

  it("hosting: invites, calendar, food and drinks, cleaning; 'Friday at 7' is 7 PM in the household timezone", async () => {
    const r = await new KeywordNeedsPass().run(input("Tell Butler six friends from the dinner crew are coming over Friday at 7."));
    expect(r.kind).toBe("hosting");
    expect(r.title).toBe("Dinner for 6, Friday 7 PM");
    expect(r.starts_at).toBe("2026-10-16T19:00:00-04:00");
    expect(r.ends_at).toBe("2026-10-16T22:00:00-04:00");
    expect(r.needs.map((n) => n.capability)).toEqual(["messages", "calendar", "supplies", "services"]);
    expect(r.needs[0]?.label).toBe("Invite 6 guests");
    expect(r.needs.every((n) => n.label.length <= 40)).toBe(true);
  });

  it("group references resolve to contacts: 'the dinner crew' with no number is 6 guests", async () => {
    const r = await new KeywordNeedsPass().run(input("The dinner crew is coming over on Saturday at 8pm"));
    expect(r.needs[0]?.label).toBe("Invite 6 guests");
    expect(r.starts_at).toBe("2026-10-17T20:00:00-04:00");
    expect(groupGuestCount("Tolu and Sam are coming", fixtures.contacts)).toBe(2);
    expect(groupGuestCount("my parents are staying", fixtures.contacts)).toBe(2);
    expect(groupGuestCount("nothing here", fixtures.contacts)).toBeUndefined();
  });

  it("extracts headcounts", () => {
    expect(extractHeadcount("six friends are coming")).toBe(6);
    expect(extractHeadcount("we have 4 people over")).toBe(4);
    expect(extractHeadcount("a couple of friends")).toBe(2);
    expect(extractHeadcount("5 of us")).toBe(4);
    expect(extractHeadcount("it is raining")).toBeUndefined();
  });

  it("away: 'Thursday to Sunday' becomes a range and parents staying stock drinks", async () => {
    const r = await new KeywordNeedsPass().run(input("I'm travelling Thursday to Sunday. My parents are staying at the house."));
    expect(r.kind).toBe("away");
    expect(r.title).toBe("Away, Thursday to Sunday");
    expect(r.starts_at).toBe("2026-10-15T00:00:00-04:00");
    expect(r.ends_at).toBe("2026-10-18T23:59:00-04:00");
    expect(r.needs.map((n) => n.capability)).toEqual(["messages", "calendar", "supplies"]);
    expect(r.needs[2]?.label).toBe("Stock drinks for your parents");
  });

  it("away without people staying pauses deliveries", async () => {
    const r = await new KeywordNeedsPass().run(input("I'm away next week on a business trip"));
    expect(r.kind).toBe("away");
    expect(r.needs[2]?.label).toBe("Pause or redirect deliveries");
  });

  it("running low: reorder the item", async () => {
    const r = await new KeywordNeedsPass().run(input("We're running low on dishwasher tablets."));
    expect(r.kind).toBe("running_low");
    expect(r.needs).toEqual([{ label: "Reorder dishwasher tablets", capability: "supplies" }]);
    expect(extractLowItem("running out of coffee and milk, so")).toBe("coffee and milk");
  });

  it("falls back to calendar + context for unclassified situations", async () => {
    const r = await new KeywordNeedsPass().run(input("Something odd is happening"));
    expect(r.kind).toBe("other");
    expect(r.needs.length).toBeGreaterThanOrEqual(2);
  });

  it("the `when` parameter wins over the situation text and handles ISO input", () => {
    const t = resolveTimes(input("guests are coming over", "Friday at 7"), "hosting");
    expect(t.starts_at).toBe("2026-10-16T19:00:00-04:00");
    const iso = resolveTimes(input("guests are coming", "2026-10-16T19:00:00-04:00"), "hosting");
    expect(iso.starts_at).toBe("2026-10-16T19:00:00-04:00");
    expect(resolveTimes(input("guests are coming"), "hosting").starts_at).toBeUndefined();
  });

  it("morning words keep AM, evening defaults to PM", () => {
    expect(resolveTimes(input("brunch Saturday at 10 in the morning"), "hosting").starts_at).toBe("2026-10-17T10:00:00-04:00");
    expect(resolveTimes(input("party Saturday at 9"), "hosting").starts_at).toBe("2026-10-17T21:00:00-04:00");
  });

  it("buildKeywordResult honours a kind override", () => {
    expect(buildKeywordResult(input("something"), "hosting").kind).toBe("hosting");
  });
});

describe("Bedrock needs pass", () => {
  const toolReply = (obj: unknown) => ({ output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "plan_needs", input: obj } }] } } });

  it("uses the model's kind/title/needs but resolves dates locally", async () => {
    const send = vi.fn().mockResolvedValue(
      toolReply({
        kind: "hosting",
        title: "Dinner for 6, Friday 7 PM",
        needs: [
          { label: "Invite 6 guests", capability: "messages" },
          { label: "Add dinner to calendar", capability: "calendar" },
          { label: "Order drinks", capability: "supplies" },
          { label: "Book a cleaner", capability: "services" },
        ],
      }),
    );
    const bp = new BedrockNeedsPass({ modelId: "m", fallback: new KeywordNeedsPass(), client: { send } as never });
    const r = await bp.run(input("six friends are coming over Friday at 7"));
    expect(r.source).toBe("bedrock");
    expect(r.starts_at).toBe("2026-10-16T19:00:00-04:00");
    expect(r.needs).toHaveLength(4);
    // the request is a forced tool call, small and deterministic
    const cmd = send.mock.calls[0]?.[0] as { input: { toolConfig: { toolChoice: unknown }; inferenceConfig: { temperature: number } } };
    expect(cmd.input.toolConfig.toolChoice).toEqual({ tool: { name: "plan_needs" } });
    expect(cmd.input.inferenceConfig.temperature).toBe(0);
  });

  it("falls back to keywords on invalid output, errors and timeouts", async () => {
    const fallback = new KeywordNeedsPass();
    for (const send of [
      vi.fn().mockResolvedValue(toolReply({ kind: "nonsense", title: "x", needs: [] })),
      vi.fn().mockResolvedValue({ output: { message: { content: [{ text: "no tool" }] } } }),
      vi.fn().mockRejectedValue(new Error("ThrottlingException")),
      vi.fn().mockImplementation((_cmd: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_, reject) => opts.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))))),
    ]) {
      const bp = new BedrockNeedsPass({ modelId: "m", fallback, client: { send } as never, timeoutMs: 40 });
      const r = await bp.run(input("six friends are coming over Friday at 7"));
      expect(r.source).toBe("keywords");
      expect(r.kind).toBe("hosting");
    }
  });
});
