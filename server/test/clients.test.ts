import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AgentClientImpl,
  AgentCoreTransport,
  LocalAgentTransport,
  padSessionId,
  UnconfiguredAgentTransport,
  type AgentTransport,
} from "../src/lib/agentClient.js";
import {
  ExecutorClientImpl,
  LambdaExecutorTransport,
  LocalExecutorTransport,
  UnconfiguredExecutorTransport,
} from "../src/lib/executorClient.js";
import { cleaningDecision, fixtures, HH, receiptByTitle } from "./helpers.js";

let server: Server;
let base: string;
let mode: "ok" | "text" | "slow" | "500json" | "propagating" | "unsupported" | "badshape" = "ok";
const received: Array<{ url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];

const rule = fixtures.rules[5]!;
const draftRule = { ...rule, policy_status: "draft", active: false };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      received.push({ url: req.url ?? "", headers: req.headers, body });
      const send = (status: number, obj: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (mode === "text") return void res.end("<html>oops</html>");
      if (mode === "slow") return; // never answer
      if (mode === "500json") return send(500, { ok: false, error: { code: "INTERNAL", message: "kaboom" } });
      if (mode === "badshape") return send(200, { nope: 1 });
      if (req.url === "/invocations") {
        const op = body["op"];
        if (op === "start_plan" || op === "resume_plan") return send(200, { ok: true, data: { accepted: true } });
        if (op === "draft_rule") {
          if (mode === "unsupported") return send(200, { ok: false, error: { code: "RULE_UNSUPPORTED", message: "no template" } });
          return send(200, { ok: true, data: { draft: { template: "ask_category", params: { category: "drinks" }, text: rule.text, effect: "ask_first", confidence: 0.9 }, rule: draftRule } });
        }
        if (op === "apply_rule") {
          if (mode === "propagating") return send(200, { ok: false, error: { code: "POLICY_PROPAGATING", message: "creating" }, data: { rule: { ...rule, policy_status: "creating", active: false } } });
          return send(200, { ok: true, data: { rule } });
        }
        if (op === "remove_rule") return send(200, { ok: true, data: { rule: { ...rule, active: false, policy_status: "disabled" } } });
      }
      if (req.url === "/invoke") {
        if (body["mode"] === "decision") {
          const d = cleaningDecision();
          return send(200, { ok: true, data: { decision: { ...d, status: "executed" }, receipt: receiptByTitle("Booked BrightHome") } });
        }
        return send(200, { ok: true, data: { original: { ...receiptByTitle("Bought drinks for 7"), status: "undone" }, undo: receiptByTitle("Bought drinks for 7") } });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.closeAllConnections?.() ?? r());
  await new Promise<void>((r) => server.close(() => r()));
});

const ctx = { householdId: HH, correlationId: "cor_X" };

describe("agent client over local HTTP (AGENT_LOCAL_URL)", () => {
  const agent = () => new AgentClientImpl(new LocalAgentTransport(`${base}/invocations`));

  it("posts the AgentRequest envelope for every op", async () => {
    mode = "ok";
    received.length = 0;
    const a = agent();
    await a.startPlan(ctx, "plan_1");
    await a.resumePlan(ctx, "plan_1", "dec_1");
    const d = await a.draftRule(ctx, { correction: "no drinks", actionId: "act_1", baseRuleId: "rule_0" });
    const applied = await a.applyRule(ctx, rule.rule_id);
    const removed = await a.removeRule(ctx, rule.rule_id);
    expect(received.map((r) => r.body)).toEqual([
      { op: "start_plan", household_id: HH, correlation_id: "cor_X", plan_id: "plan_1" },
      { op: "resume_plan", household_id: HH, correlation_id: "cor_X", plan_id: "plan_1", decision_id: "dec_1" },
      { op: "draft_rule", household_id: HH, correlation_id: "cor_X", correction: "no drinks", action_id: "act_1", base_rule_id: "rule_0" },
      { op: "apply_rule", household_id: HH, correlation_id: "cor_X", rule_id: rule.rule_id },
      { op: "remove_rule", household_id: HH, correlation_id: "cor_X", rule_id: rule.rule_id },
    ]);
    expect(d.rule.rule_id).toBe(rule.rule_id);
    expect(d.draft?.template).toBe("ask_category");
    expect(applied).toMatchObject({ propagating: false, rule: { active: true } });
    expect(removed.rule?.active).toBe(false);
    expect(received[0]?.headers["x-butler-session"]).toBe("butler-plan_1");
  });

  it("maps error envelopes to §14 codes", async () => {
    mode = "unsupported";
    await expect(agent().draftRule(ctx, { correction: "x" })).rejects.toMatchObject({ code: "RULE_UNSUPPORTED" });
    mode = "propagating";
    expect(await agent().applyRule(ctx, "r")).toMatchObject({ propagating: true, rule: { policy_status: "creating" } });
    mode = "500json";
    await expect(agent().startPlan(ctx, "p")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("garbage, non-JSON, unexpected bodies and dead ports are UPSTREAM_UNAVAILABLE", async () => {
    for (const m of ["text", "badshape"] as const) {
      mode = m;
      await expect(agent().startPlan(ctx, "p")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    }
    const dead = new AgentClientImpl(new LocalAgentTransport("http://127.0.0.1:1/invocations"));
    await expect(dead.startPlan(ctx, "p")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(new AgentClientImpl(new UnconfiguredAgentTransport()).startPlan(ctx, "p")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("times out", async () => {
    mode = "slow";
    const t = new LocalAgentTransport(`${base}/invocations`);
    const started = Date.now();
    await expect(t.invoke({ op: "start_plan", household_id: HH, correlation_id: "c", plan_id: "p" }, { timeoutMs: 150, sessionId: "s" })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(1500);
    mode = "ok";
  });
});

describe("agent client over AgentCore (InvokeAgentRuntime)", () => {
  it("pads session ids to >= 33 chars and parses the streamed JSON body", async () => {
    expect(padSessionId("butler-plan_1").length).toBeGreaterThanOrEqual(33);
    expect(padSessionId("x".repeat(40))).toBe("x".repeat(40));
    const send = vi.fn().mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ ok: true, data: { accepted: true } }) } });
    const t = new AgentCoreTransport("arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/butler", { send } as never);
    await new AgentClientImpl(t).startPlan(ctx, "plan_1");
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input["agentRuntimeArn"]).toContain("runtime/butler");
    expect((input["runtimeSessionId"] as string).length).toBeGreaterThanOrEqual(33);
    expect(input["contentType"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(input["payload"] as Uint8Array))).toMatchObject({ op: "start_plan", plan_id: "plan_1" });
  });

  it("rule ops use butler-rules-<household>-<ulid> sessions and errors map to UPSTREAM_UNAVAILABLE", async () => {
    const send = vi.fn().mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ ok: true, data: { draft: null, rule: draftRule } }) } });
    const a = new AgentClientImpl(new AgentCoreTransport("arn", { send } as never));
    await a.draftRule(ctx, { correction: "x" });
    expect(((send.mock.calls[0]![0] as { input: { runtimeSessionId: string } }).input.runtimeSessionId)).toMatch(/^butler-rules-hh_demo-[0-9A-Z]{26}$/);
    const failing = new AgentClientImpl(new AgentCoreTransport("arn", { send: vi.fn().mockRejectedValue(new Error("AccessDenied")) } as never));
    await expect(failing.startPlan(ctx, "p")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("agent session id helper keeps the real plan session >= 33 chars", () => {
    const planId = fixtures.planHosting.plan_id;
    expect(padSessionId(`butler-${planId}`).length).toBeGreaterThanOrEqual(33);
  });
});

describe("executor client", () => {
  const exec = () => new ExecutorClientImpl(new LocalExecutorTransport(`${base}/invoke`));

  it("decision mode returns the decision and receipt", async () => {
    mode = "ok";
    received.length = 0;
    const d = cleaningDecision();
    const res = await exec().runDecision(ctx, d.decision_id, d.options[1]!.option_id);
    expect(received[0]?.body).toEqual({ mode: "decision", household_id: HH, correlation_id: "cor_X", decision_id: d.decision_id, option_id: d.options[1]!.option_id });
    expect(res.decision.status).toBe("executed");
    expect(res.receipt.title).toBe("Booked BrightHome");
  });

  it("undo mode tolerates {original, undo} and {receipt}", async () => {
    mode = "ok";
    const res = await exec().undo(ctx, "act_1");
    expect(res.undo.title).toBe("Bought drinks for 7");
    expect(res.original?.status).toBe("undone");
    const t = { invoke: async () => ({ ok: true, data: { receipt: receiptByTitle("Booked BrightHome") } }) };
    expect((await new ExecutorClientImpl(t).undo(ctx, "a")).original).toBeUndefined();
  });

  it("maps executor errors and transport failures", async () => {
    const mk = (error: { code: string; message?: string }) => new ExecutorClientImpl({ invoke: async () => ({ ok: false, error }) });
    await expect(mk({ code: "BLOCKED_BY_NEVER_RULE" }).runDecision(ctx, "d", "o")).rejects.toMatchObject({ code: "BLOCKED_BY_NEVER_RULE" });
    await expect(mk({ code: "NOT_REVERSIBLE" }).undo(ctx, "a")).rejects.toMatchObject({ code: "NOT_REVERSIBLE" });
    await expect(mk({ code: "PROVIDER_DOWN", message: "x" }).runDecision(ctx, "d", "o")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    mode = "text";
    await expect(exec().runDecision(ctx, "d", "o")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    mode = "ok";
    await expect(new ExecutorClientImpl(new LocalExecutorTransport("http://127.0.0.1:1/invoke")).undo(ctx, "a")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(new ExecutorClientImpl(new UnconfiguredExecutorTransport()).undo(ctx, "a")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const bad = new ExecutorClientImpl({ invoke: async () => ({ ok: true, data: { decision: {}, receipt: {} } }) });
    await expect(bad.runDecision(ctx, "d", "o")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("enforces the timeout (8 s default, configurable)", async () => {
    mode = "slow";
    const quick = new ExecutorClientImpl(new LocalExecutorTransport(`${base}/invoke`), 150);
    const started = Date.now();
    await expect(quick.runDecision(ctx, "d", "o")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(1500);
    mode = "ok";
  });

  it("Lambda transport invokes the function and surfaces FunctionError", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ ok: true, data: { original: receiptByTitle("Bought drinks for 7"), undo: receiptByTitle("Bought drinks for 7") } }));
    const send = vi.fn().mockResolvedValue({ Payload: payload });
    const res = await new ExecutorClientImpl(new LambdaExecutorTransport("butler-approval-executor", { send } as never)).undo(ctx, "a");
    expect(res.undo.title).toBe("Bought drinks for 7");
    const input = (send.mock.calls[0]![0] as { input: { FunctionName: string } }).input;
    expect(input.FunctionName).toBe("butler-approval-executor");
    const failing = new ExecutorClientImpl(new LambdaExecutorTransport("f", { send: vi.fn().mockResolvedValue({ FunctionError: "Unhandled" }) } as never));
    await expect(failing.undo(ctx, "a")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("AgentTransport contract", () => {
  it("is satisfiable by a plain object", async () => {
    const t: AgentTransport = { invoke: async () => ({ ok: true, data: {} }) };
    await expect(new AgentClientImpl(t).startPlan(ctx, "p")).resolves.toBeUndefined();
  });
});
