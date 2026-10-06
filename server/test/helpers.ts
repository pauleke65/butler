/** Shared test fixtures: pinned clock, seeded in-memory repo, scriptable fake agent and executor. */
import { expect } from "vitest";
import { testConfig } from "../src/config.js";
import { createBackground, type Deps } from "../src/deps.js";
import { FakeAgent, FakeExecutor } from "../src/dev/fakes.js";
import { fixtures, HH, NOW, REPO_ROOT, FIXTURES_DIR, SEED_DIR, cleaningDecision, drinksDecision, receiptByTitle, seedRepo } from "../src/dev/fixtures.js";
import { makeIdGenerator } from "../src/lib/ids.js";
import { createCapturingLogger } from "../src/lib/logger.js";
import { createMemoryRepo } from "../src/lib/memoryRepo.js";
import { KeywordNeedsPass, type NeedsPass } from "../src/lib/needsPass.js";
import type { ToolContext } from "../src/tools/spec.js";
import { TOOL_BY_NAME } from "../src/tools/index.js";

export { fixtures, HH, NOW, REPO_ROOT, FIXTURES_DIR, SEED_DIR, cleaningDecision, drinksDecision, receiptByTitle, seedRepo, FakeAgent, FakeExecutor };

// ───────────────────────────── deps ─────────────────────────────

export interface TestEnv {
  deps: Deps;
  repo: ReturnType<typeof createMemoryRepo>;
  agent: FakeAgent;
  executor: FakeExecutor;
  logger: ReturnType<typeof createCapturingLogger>;
  settle(): Promise<void>;
  clock: { set(d: Date): void; advance(ms: number): void };
  ctx: ToolContext;
  call(tool: string, args?: unknown): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>;
}

export async function makeEnv(opts: { seed?: boolean | { plans?: boolean; receipts?: boolean; rules?: boolean }; needsPass?: NeedsPass; now?: Date; budgetMs?: number } = {}): Promise<TestEnv> {
  let current = opts.now ?? NOW;
  const now = (): Date => new Date(current.getTime());
  const logger = createCapturingLogger();
  const repo = createMemoryRepo({ nowSeconds: () => Math.floor(current.getTime() / 1000) });
  const newId = makeIdGenerator(() => current.getTime());
  const bg = createBackground(logger);
  const agent = new FakeAgent(repo, now, newId);
  const executor = new FakeExecutor(repo, now, newId);
  const config = testConfig({ ...(opts.budgetMs ? { handleSituationBudgetMs: opts.budgetMs } : {}) });
  const deps: Deps = { repo, agent, executor, needsPass: opts.needsPass ?? new KeywordNeedsPass(), now, newId, config, logger, background: bg.run };
  if (opts.seed !== false) await seedRepo(repo, typeof opts.seed === "object" ? opts.seed : {});
  const ctx: ToolContext = { deps, householdId: HH, correlationId: "cor_TEST", log: logger };
  return {
    deps, repo, agent, executor, logger, settle: bg.settle, ctx,
    clock: {
      set(d) { current = d; },
      advance(ms) { current = new Date(current.getTime() + ms); },
    },
    async call(tool, args = {}) {
      const spec = TOOL_BY_NAME.get(tool);
      if (!spec) throw new Error(`unknown tool ${tool}`);
      return spec.run(args, ctx);
    },
  };
}

export function sc<T = Record<string, unknown>>(res: { structuredContent?: unknown }): T {
  return res.structuredContent as T;
}


// ───────────────────────────── envelope assertions ─────────────────────────────


import { ToolError } from "@butler/contracts";
import { VIEW_URI } from "../src/lib/views.js";
import { lintSpoken } from "../src/lib/lintSpoken.js";

/**
 * Asserts the response envelope (contracts §3.1 / §14) for any tool result: structuredContent + a text content
 * block holding the same JSON, `_meta.ui` on success, a spoken summary that passes lintSpoken, and, on success,
 * structuredContent that validates against the tool's outputSchema.
 */
export function assertEnvelope(tool: string, res: import("@modelcontextprotocol/sdk/types.js").CallToolResult): Record<string, any> {
  const spec = TOOL_BY_NAME.get(tool);
  if (!spec) throw new Error(`unknown tool ${tool}`);
  expect(res.content, "content must never be empty").toBeDefined();
  expect(res.content.length).toBeGreaterThan(0);
  const first = res.content[0] as { type: string; text: string };
  expect(first.type).toBe("text");
  expect(res.structuredContent).toBeDefined();
  expect(JSON.parse(first.text)).toEqual(res.structuredContent);
  const body = res.structuredContent as Record<string, any>;
  expect(typeof body.spoken_summary).toBe("string");
  expect(lintSpoken(body.spoken_summary), `spoken_summary lint for ${tool}: ${body.spoken_summary}`).toEqual([]);
  if (res.isError) {
    expect(body.ok).toBe(false);
    expect(ToolError.safeParse(body.error).success, JSON.stringify(body.error)).toBe(true);
    expect(body.error.message_spoken).toBe(body.spoken_summary);
    expect(lintSpoken(body.error.message_spoken)).toEqual([]);
    if (body.error.candidates) expect(body.error.candidates.length).toBeLessThanOrEqual(3);
    expect(res._meta).toBeUndefined();
  } else {
    expect(body.ok).toBe(true);
    const parsed = spec.output.safeParse(body);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (spec.ui) {
      const ui = (res._meta as { ui: { resourceUri: string; invoking: string; invoked: string } }).ui;
      expect(Object.values(VIEW_URI)).toContain(ui.resourceUri);
      expect(ui.invoking.length).toBeLessThanOrEqual(30);
      expect(ui.invoked.length).toBeLessThanOrEqual(30);
    }
  }
  return body;
}

export function expectError(res: import("@modelcontextprotocol/sdk/types.js").CallToolResult, tool: string, code: string): Record<string, any> {
  const body = assertEnvelope(tool, res);
  expect(res.isError).toBe(true);
  expect(body.error.code).toBe(code);
  return body;
}
