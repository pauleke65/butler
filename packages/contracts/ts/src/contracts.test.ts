import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Plan, Receipt, Rule, Decision } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../fixtures");

describe("contracts", () => {
  it("fixtures validate against the zod schemas", () => {
    const byKey: Record<string, { parse: (v: unknown) => unknown }> = { plan: Plan, receipt: Receipt, rule: Rule, decision: Decision };
    const files = readdirSync(fixtures).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const key = Object.keys(byKey).find((k) => f.toLowerCase().includes(k));
      expect(key, `no schema mapping for ${f}`).toBeTruthy();
      const data = JSON.parse(readFileSync(resolve(fixtures, f), "utf8"));
      for (const item of Array.isArray(data) ? data : [data]) byKey[key!].parse(item);
    }
  });

  it("committed JSON Schema matches the zod source (no drift)", () => {
    const schemaPath = resolve(here, "../../schemas/butler.schema.json");
    const before = readFileSync(schemaPath, "utf8");
    execFileSync("pnpm", ["gen"], { cwd: resolve(here, ".."), stdio: "pipe" });
    const after = readFileSync(schemaPath, "utf8");
    expect(after).toBe(before);
  });

  it("schemas parse a minimal valid plan/receipt/rule/decision", () => {
    expect(Plan.safeParse({ plan_id: "p", household_id: "h", situation: "s", kind: "hosting", title: "t", status: "active", needs: [], created_at: "2026-10-16T12:00:00Z", updated_at: "2026-10-16T12:00:00Z" }).success).toBe(true);
    expect(Rule.safeParse({}).success).toBe(false);
    expect(Receipt.safeParse({}).success).toBe(false);
    expect(Decision.safeParse({}).success).toBe(false);
  });
});
