import { describe, expect, it } from "vitest";
import { makeIdGenerator, ulid } from "../src/lib/ids.js";
import {
  isoInTz,
  numberWord,
  spokenDay,
  spokenMoney,
  spokenTime,
  spokenWhen,
  startOfDayInTz,
  tzOffsetMinutes,
  zonedToInstant,
  toUtcIso,
} from "../src/lib/time.js";
import { ButlerError, mapError, withTimeout } from "../src/lib/errors.js";
import { z } from "zod";
import { joinNames, ruleAsPromise } from "../src/lib/spoken.js";
import { authenticate, householdFor } from "../src/lib/auth.js";
import { testConfig } from "../src/config.js";

const NY = "America/New_York";
const NOW = new Date("2026-10-14T18:04:00+00:00");

describe("ids", () => {
  it("generates prefixed 26 char ULIDs that sort in creation order within a millisecond", () => {
    const gen = makeIdGenerator(() => 1_760_000_000_000);
    const ids = Array.from({ length: 50 }, () => gen("need"));
    expect(ids.every((i) => /^need_[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ulid(0)).toHaveLength(26);
  });
});

describe("time helpers", () => {
  it("computes offsets with DST", () => {
    expect(tzOffsetMinutes(new Date("2026-10-14T18:00:00Z"), NY)).toBe(-240);
    expect(tzOffsetMinutes(new Date("2026-12-14T18:00:00Z"), NY)).toBe(-300);
  });

  it("round trips wall clock time to an instant", () => {
    const d = zonedToInstant({ year: 2026, month: 10, day: 16, hour: 19 }, NY);
    expect(d.toISOString()).toBe("2026-10-16T23:00:00.000Z");
    expect(isoInTz(d, NY)).toBe("2026-10-16T19:00:00-04:00");
    // across the fall-back DST change (2026-11-01)
    expect(isoInTz(zonedToInstant({ year: 2026, month: 11, day: 2, hour: 9 }, NY), NY)).toBe("2026-11-02T09:00:00-05:00");
  });

  it("formats UTC stamps like the Python store", () => {
    expect(toUtcIso(NOW)).toBe("2026-10-14T18:04:00+00:00");
  });

  it("speaks days, times and money per §15", () => {
    const friday = new Date("2026-10-16T23:00:00Z");
    expect(spokenTime(friday, NY)).toBe("7 PM");
    expect(spokenTime(new Date("2026-10-16T23:30:00Z"), NY)).toBe("7:30 PM");
    expect(spokenDay(friday, NOW, NY)).toBe("Friday");
    expect(spokenDay(new Date("2026-10-15T23:00:00Z"), NOW, NY)).toBe("tomorrow");
    expect(spokenDay(NOW, NOW, NY)).toBe("today");
    expect(spokenDay(new Date("2026-10-30T23:00:00Z"), NOW, NY)).toBe("October 30");
    expect(spokenWhen(friday, NOW, NY)).toBe("Friday at 7 PM");
    expect(spokenMoney(4200)).toBe("42 dollars");
    expect(spokenMoney(4250)).toBe("42 dollars 50");
    expect(spokenMoney(100)).toBe("1 dollar");
    expect(numberWord(6)).toBe("six");
    expect(numberWord(14)).toBe("14");
    expect(startOfDayInTz(NOW, NY).toISOString()).toBe("2026-10-14T04:00:00.000Z");
  });
});

describe("errors", () => {
  it("maps zod and unknown errors to §14 codes", () => {
    const zerr = z.object({ a: z.string() }).safeParse({}).error as z.ZodError;
    expect(mapError(zerr).code).toBe("INVALID_INPUT");
    expect(mapError(new Error("boom")).code).toBe("INTERNAL");
    expect(mapError(new Error("fetch failed")).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(mapError("string").code).toBe("INTERNAL");
    const be = new ButlerError("NOT_FOUND");
    expect(mapError(be)).toBe(be);
  });

  it("withTimeout rejects with UPSTREAM_UNAVAILABLE", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "thing")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(withTimeout(Promise.resolve(5), 20, "thing")).resolves.toBe(5);
  });
});

describe("spoken helpers", () => {
  it("joins names with at most three then 'and N others'", () => {
    expect(joinNames(["Tolu"])).toBe("Tolu");
    expect(joinNames(["Tolu", "Sam"])).toBe("Tolu and Sam");
    expect(joinNames(["Tolu", "Sam", "Ada"])).toBe("Tolu, Sam and Ada");
    expect(joinNames(["Tolu", "Sam", "Ada", "Chris", "Maya", "Dee"])).toBe("Tolu, Sam, Ada and 3 others");
  });

  it("rewrites rule text as a first person promise", () => {
    expect(ruleAsPromise("Ask me before buying drinks.")).toBe("I'll ask before buying drinks");
    expect(ruleAsPromise("Never message Jordan.")).toBe("I'll never message Jordan");
    expect(ruleAsPromise("Always ask me before booking a service.")).toBe("I'll always ask before booking a service");
    expect(ruleAsPromise("Ask me before spending more than 50 dollars.")).toBe("I'll ask before spending more than 50 dollars");
  });
});

describe("lowerFirst", () => {
  it("keeps acronyms and lowers ordinary words", async () => {
    const { lowerFirst } = await import("../src/lib/spoken.js");
    expect(lowerFirst("OK to buy drinks?")).toBe("OK to buy drinks?");
    expect(lowerFirst("Which cleaner should I book?")).toBe("which cleaner should I book?");
    expect(lowerFirst("")).toBe("");
  });
});

describe("auth", () => {
  const cfg = testConfig({ householdBySub: { "*": "hh_demo", "special-sub": "hh_other" } });
  const jwt = (claims: object): string => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

  it("local stage: no auth or the static sim token", () => {
    expect(authenticate(undefined, cfg)).toMatchObject({ ok: true, principal: { householdId: "hh_demo" } });
    expect(authenticate("Bearer local-sim-token", cfg)).toMatchObject({ ok: true, principal: { sub: "local-sim" } });
    expect(authenticate("Bearer nonsense", cfg)).toMatchObject({ ok: false, status: 401 });
  });

  it("non-local stage requires a bearer and maps sub to a household", () => {
    const prod = testConfig({ stage: "demo", householdBySub: { "sim-client": "hh_demo" } });
    expect(authenticate(undefined, prod)).toMatchObject({ ok: false });
    expect(authenticate(`Bearer ${jwt({ sub: "sim-client" })}`, prod)).toMatchObject({ ok: true, principal: { householdId: "hh_demo" } });
    expect(authenticate(`Bearer ${jwt({ client_id: "sim-client" })}`, prod)).toMatchObject({ ok: true });
    expect(authenticate(`Bearer ${jwt({ sub: "stranger" })}`, prod)).toMatchObject({ ok: false });
  });

  it("household map falls back to the wildcard", () => {
    expect(householdFor("special-sub", cfg.householdBySub)).toBe("hh_other");
    expect(householdFor("anyone", cfg.householdBySub)).toBe("hh_demo");
    expect(authenticate(`Bearer ${jwt({ sub: "special-sub" })}`, cfg)).toMatchObject({ ok: true, principal: { householdId: "hh_other" } });
  });
});
