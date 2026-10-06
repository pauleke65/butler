#!/usr/bin/env node
// Mock of the Butler debug API (contracts section 11) so the Black Box panel can be developed and tested
// without the Python side. Read-only routes need `Authorization: Bearer local-debug-token`.
//
//   node mock/debug-api.mjs            # seeded history + 5 default rules, idle
//   node mock/debug-api.mjs --demo     # also replays the golden-demo moments (ALLOW, new rule, DENY) after start
//   POST /__mock/receipt {...} | POST /__mock/rule {...} | POST /__mock/reset   (same bearer token)
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTs = 0;
let lastRand = 0;
/** Monotonic, lexicographically sortable ULID-like id: ts(10) + counter/random(16). */
export function ulid(ts = Date.now()) {
  if (ts <= lastTs) {
    ts = lastTs;
    lastRand++;
  } else {
    lastTs = ts;
    lastRand = 0;
  }
  let t = "";
  let n = ts;
  for (let i = 0; i < 10; i++) {
    t = B32[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const rnd = randomBytes(10);
  let r = "";
  for (const b of rnd) r += B32[b % 32];
  // counter prefix keeps same-millisecond ids ordered
  const c = lastRand.toString(32).toUpperCase().padStart(2, "0").slice(-2);
  return t + c + r.slice(0, 14);
}

const iso = (ts = Date.now()) => new Date(ts).toISOString();

export function defaultRules(now = Date.now()) {
  const mk = (rule_id, text, template, effect = "ask_first") => ({
    rule_id, household_id: "hh_demo", text, effect, template, params: {}, cedar_statement: "", policy_status: "active",
    origin: { type: "default" }, active: true, created_at: iso(now - 86_400_000 * 30), updated_at: iso(now - 86_400_000 * 30),
  });
  return [
    mk("rule_default_spend", "Ask me before spending more than 50 dollars.", "spend_cap"),
    mk("rule_default_contacts", "Ask me before messaging anyone who isn't a saved contact.", "ask_non_contact"),
    mk("rule_default_calendar", "Never change or delete events I created.", "protect_human_events", "never"),
    mk("rule_default_services", "Always ask me before booking a service.", "ask_tool"),
    mk("rule_default_refunds", "Ask me before refunding anything.", "ask_tool"),
  ];
}

export function makeReceipt(o = {}) {
  const tool = o.tool ?? "Supplies___checkout";
  const decision = o.decision ?? "ALLOW";
  return {
    action_id: o.action_id ?? ulid(o.at),
    household_id: "hh_demo",
    correlation_id: ulid(),
    action: { tool, args: o.args ?? {} },
    title: o.title ?? (decision === "DENY" ? "Held: drinks purchase" : "Bought drinks"),
    status: o.status ?? (decision === "DENY" ? "held_for_approval" : "executed"),
    reasons: o.reasons ?? [],
    context_used: [],
    alternatives: [],
    authority: {
      decision,
      principal: o.principal ?? "butler-agent",
      rule_ids: o.rule_ids ?? [],
      rule_texts: o.rule_texts ?? [],
      evaluated_at: iso(o.at),
      matcher_gateway_agree: true,
    },
    ...(o.amount_minor !== undefined ? { cost: { amount_minor: o.amount_minor, currency: "USD" } } : {}),
    reversible: true,
    might_disagree: { score: 0 },
    simulated: true,
    spoken_summary: "",
    created_at: iso(o.at),
  };
}

export function createMockDebugApi({ token = "local-debug-token", port = 8085, demo = false, log = () => {} } = {}) {
  let receipts = [];
  let rules = [];
  let timers = [];

  function seed() {
    const now = Date.now();
    rules = defaultRules(now);
    receipts = [
      makeReceipt({ at: now - 86_400_000 * 25, amount_minor: 2800, args: { category: "drinks", amount_minor: 2800 }, rule_ids: ["rule_default_spend"], rule_texts: ["Ask me before spending more than 50 dollars."] }),
      makeReceipt({ at: now - 86_400_000 * 20, amount_minor: 3300, args: { category: "drinks", amount_minor: 3300 }, rule_ids: ["rule_default_spend"], rule_texts: ["Ask me before spending more than 50 dollars."] }),
    ];
  }

  function playDemo() {
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    at(2000, () => receipts.push(makeReceipt({ tool: "Messages___send_email", title: "Invited 6 guests", args: { recipient_contact_ids: ["c_tolu"] }, rule_ids: ["rule_default_contacts"], rule_texts: ["Ask me before messaging anyone who isn't a saved contact."] })));
    at(4000, () => receipts.push(makeReceipt({ title: "Bought drinks", amount_minor: 4200, args: { category: "drinks", amount_minor: 4200 }, rule_ids: ["rule_default_spend"], rule_texts: ["Ask me before spending more than 50 dollars."] })));
    at(8000, () => receipts.push(makeReceipt({ tool: "Services___book_service", title: "Booked BrightHome", amount_minor: 8500, principal: "approval-executor", args: { amount_minor: 8500 }, rule_ids: ["rule_default_services"], rule_texts: ["Always ask me before booking a service."] })));
    at(11000, () => rules.push({ rule_id: "rule_demo_drinks", household_id: "hh_demo", text: "Ask me before buying drinks.", effect: "ask_first", template: "ask_category", params: { category: "drinks" }, cedar_statement: "", policy_status: "active", origin: { type: "correction", utterance: "Don't buy drinks without asking me." }, active: true, created_at: iso(), updated_at: iso() }));
    at(14000, () => receipts.push(makeReceipt({ decision: "DENY", title: "Held: drinks purchase", amount_minor: 3100, args: { category: "drinks", amount_minor: 3100 }, rule_ids: ["rule_demo_drinks"], rule_texts: ["Ask me before buying drinks."] })));
  }

  function reset() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    seed();
    if (demo) playDemo();
  }
  reset();

  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  };

  const server = createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json", ...cors }).end(JSON.stringify(body));
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    try {
      if (req.method === "GET" && url.pathname === "/receipts") {
        const since = url.searchParams.get("since");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
        let list = [...receipts].sort((a, b) => (a.action_id < b.action_id ? -1 : 1));
        if (since) list = list.filter((r) => r.action_id > since);
        return send(200, { receipts: list.slice(-limit) });
      }
      if (req.method === "GET" && url.pathname === "/rules") return send(200, { rules });
      if (req.method === "GET" && url.pathname === "/policy-events") {
        return send(200, { events: receipts.map((r) => ({ at: r.created_at, principal: r.authority.principal, tool: r.action.tool, decision: r.authority.decision, rule_ids: r.authority.rule_ids })) });
      }
      if (req.method === "POST" && url.pathname === "/__mock/receipt") {
        const r = makeReceipt(await readBody(req));
        receipts.push(r);
        return send(201, r);
      }
      if (req.method === "POST" && url.pathname === "/__mock/rule") {
        const o = await readBody(req);
        const rule = { rule_id: o.rule_id ?? `rule_${ulid()}`, household_id: "hh_demo", text: o.text ?? "Ask me before buying drinks.", effect: o.effect ?? "ask_first", template: o.template ?? "ask_category", params: {}, cedar_statement: "", policy_status: o.policy_status ?? "active", origin: { type: "correction", utterance: "mock" }, active: o.active ?? true, created_at: iso(), updated_at: iso() };
        const i = rules.findIndex((x) => x.rule_id === rule.rule_id);
        if (i >= 0) rules[i] = { ...rules[i], ...rule };
        else rules.push(rule);
        return send(201, rule);
      }
      if (req.method === "POST" && url.pathname === "/__mock/reset") {
        reset();
        return send(200, { ok: true });
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: String(err) });
    }
  });

  return {
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { for (const t of timers) clearTimeout(t); server.closeAllConnections?.(); server.close(() => resolve()); }),
    reset,
    get receipts() { return receipts; },
    get rules() { return rules; },
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  const port = Number(process.env.MOCK_DEBUG_PORT ?? 8085);
  const api = createMockDebugApi({ port, demo: process.argv.includes("--demo") });
  const p = await api.listen();
  console.log(`mock debug API: http://localhost:${p}  (Authorization: Bearer local-debug-token)${process.argv.includes("--demo") ? "  [demo timeline running]" : ""}`);
}
