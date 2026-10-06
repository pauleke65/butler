/**
 * Demo/preview server: the REAL Butler MCP server and tools over an in-memory repo seeded from
 * packages/contracts/fixtures, with scripted stand-ins for the agent and the approval executor.
 * No DynamoDB, Python or AWS needed. Used by `pnpm --filter ./server/ui preview:fixtures` and handy for
 * poking the server with any MCP client:  pnpm --filter ./server dev:fixtures  (http://127.0.0.1:8001/mcp)
 */
import { createServer as createHttpServer } from "node:http";
import { testConfig } from "../config.js";
import { createBackground, type Deps } from "../deps.js";
import { createHandler } from "../http.js";
import { makeIdGenerator } from "../lib/ids.js";
import { createLogger } from "../lib/logger.js";
import { createMemoryRepo } from "../lib/memoryRepo.js";
import { KeywordNeedsPass } from "../lib/needsPass.js";
import { FakeAgent, FakeExecutor } from "./fakes.js";
import { fixtures, HH, NOW, seedRepo } from "./fixtures.js";

export async function makeFixtureDeps(): Promise<Deps> {
  const logger = createLogger({ level: "warn" });
  const now = (): Date => new Date(NOW.getTime());
  const repo = createMemoryRepo({ nowSeconds: () => Math.floor(NOW.getTime() / 1000) });
  const newId = makeIdGenerator(() => NOW.getTime() + 60 * 60_000);
  await seedRepo(repo);
  return {
    repo,
    agent: new FakeAgent(repo, now, newId),
    executor: new FakeExecutor(repo, now, newId),
    needsPass: new KeywordNeedsPass(),
    now,
    newId,
    config: testConfig({ stage: "local" }),
    logger,
    background: createBackground(logger).run,
  };
}

export function fixtureIds(): Record<string, unknown> {
  const r = (title: string): string => fixtures.receipts.find((x) => x.title === title)?.action_id ?? "";
  return {
    household_id: HH,
    plan_hosting: fixtures.planHosting.plan_id,
    plan_away: fixtures.planAway.plan_id,
    decision_cleaning: fixtures.decisions.find((d) => d.kind === "choose_option")?.decision_id,
    decision_drinks: fixtures.decisions.find((d) => d.kind === "approve_action")?.decision_id,
    receipt_drinks: r("Bought drinks for 7"),
    receipt_booking: r("Booked BrightHome"),
    receipt_held: r("Held a drinks purchase"),
    receipt_blocked: r("Blocked from changing your dentist event"),
    receipt_invite: r("Invited 6 guests"),
    receipt_failed: r("Tried to buy dishwasher tablets"),
    rule_spend: "rule_default_spend",
    rule_drinks: fixtures.rules.find((x) => x.template === "ask_category")?.rule_id,
  };
}

async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8001);
  let deps = await makeFixtureDeps();
  const mcp = createHandler(
    new Proxy({} as Deps, {
      get: (_t, key: string) => (deps as unknown as Record<string, unknown>)[key],
    }),
  );
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__fixtures/ids") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(fixtureIds()));
      return;
    }
    if (url.pathname === "/__fixtures/reset") {
      void makeFixtureDeps().then((d) => {
        deps = d;
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end('{"ok":true}');
      });
      return;
    }
    void mcp(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`butler fixture server on http://127.0.0.1:${port}/mcp (state resets via /__fixtures/reset)\n`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
