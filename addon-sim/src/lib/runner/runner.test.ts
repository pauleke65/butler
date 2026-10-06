import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockButler, newMockState } from "../../../test/mock-server/butler-mock";
import { serveMcp, type ServedMcp } from "../../../test/support/http";
import { OfflineBrain } from "../brain/offline";
import { McpClientManager } from "../mcp/client-manager";
import { check } from "./assert";
import { LocalDriver } from "./local-driver";
import { getPath, interpolate } from "./paths";
import { formatReport, runScript } from "./runner";
import { ScriptError, parseScript } from "./script";

describe("paths and assertions", () => {
  const doc = { plan: { kind: "hosting", needs: [{ status: "done", label: "Invite" }, { status: "needs_you", label: "Clean" }] }, n: 4200 };
  it("resolves wildcards and indices", () => {
    expect(getPath(doc, "plan.needs[*].status")).toEqual({ values: ["done", "needs_you"], wildcard: true });
    expect(getPath(doc, "plan.needs[1].label").values).toEqual(["Clean"]);
    expect(getPath(doc, "plan.nope").values).toEqual([]);
  });
  it("evaluates operators", () => {
    expect(check(doc, "plan.kind", "hosting").ok).toBe(true);
    expect(check(doc, "plan.kind", "away").ok).toBe(false);
    expect(check(doc, "plan.needs[*].status", { none_equal: "doing" }).ok).toBe(true);
    expect(check(doc, "plan.needs[*].status", { any_equal: "needs_you" }).ok).toBe(true);
    expect(check(doc, "plan.needs[*].label", { contains: "clean" }).ok).toBe(true);
    expect(check(doc, "n", { gte: 4000, lt: 5000 }).ok).toBe(true);
    expect(check(doc, "plan.needs", { length: 2 }).ok).toBe(true);
    expect(check(doc, "plan.needs[*].status", { includes_all: ["done", "needs_you"] }).ok).toBe(true);
    expect(check(doc, "plan.kind", { one_of: ["away", "hosting"] }).ok).toBe(true);
    expect(check(doc, "missing", { exists: false }).ok).toBe(true);
  });
  it("interpolates variables", () => {
    expect(interpolate({ id: "${a}", s: "x-${a}-y", n: ["${b}"] }, { a: "p1", b: 3 })).toEqual({ id: "p1", s: "x-p1-y", n: [3] });
  });
});

describe("script parsing", () => {
  it("rejects bad scripts with readable errors", () => {
    expect(() => parseScript("steps: []")).toThrow(ScriptError);
    expect(() => parseScript("steps:\n  - say: hi\n    device: x")).toThrow(/exactly one/);
    expect(() => parseScript(": bad: yaml: [")).toThrow(ScriptError);
  });
  it("parses the golden script", () => {
    const s = parseScript(readFileSync("scripts/butler-golden.yaml", "utf8"));
    expect(s.server).toBe("butler");
    expect(s.steps.filter((x) => x.say)).toHaveLength(9);
  });
});

describe("runner against the mock Butler server", () => {
  let served: ServedMcp;
  const mgr = new McpClientManager();
  beforeAll(async () => {
    const state = newMockState(300);
    served = await serveMcp(() => createMockButler(state));
    await mgr.configure([{ id: "butler", name: "Butler", url: served.url, auth: { type: "none" }, invocationName: "Butler" }]);
  });
  afterAll(async () => {
    await mgr.close();
    await served.close();
  });

  it("passes the golden script end to end", async () => {
    const script = parseScript(readFileSync("scripts/butler-golden.yaml", "utf8"));
    const driver = new LocalDriver(mgr, new OfflineBrain(), "butler", { butler: "Butler" });
    const report = await runScript(script, driver);
    const failures = report.results.filter((r) => r.status === "fail").map((r) => `${r.label}: ${r.details.join(" | ")}`);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain("PASS: ");
  });

  it("reports failures with details and honours bail", async () => {
    const script = parseScript(`
steps:
  - say: "How's Friday looking?"
    expect_tool: handle_situation
  - say: "What are my rules?"
    expect_tool: list_rules
`);
    const driver = new LocalDriver(mgr, new OfflineBrain(), "butler");
    const report = await runScript(script, driver, { bail: true });
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.details.join(" ")).toMatch(/expected tool handle_situation/);
    expect(formatReport(report)).toContain("FAIL");
  });

  it("wait_until times out with the last observed state", async () => {
    const script = parseScript(`
steps:
  - wait_until: { tool: list_rules, path: "ask_first[*].rule_id", any_equal: never_there, timeout_s: 0.3, interval_s: 0.1 }
`);
    const report = await runScript(script, new LocalDriver(mgr, new OfflineBrain(), "butler"));
    expect(report.ok).toBe(false);
    expect(report.results[0]!.details[0]).toMatch(/timed out/);
  });
});
