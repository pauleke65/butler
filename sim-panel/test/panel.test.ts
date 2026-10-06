// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockDebugApi } from "../mock/debug-api.mjs";
import { DebugPoller, panel } from "../src/panel";
import type { PanelCtx } from "../src/types";

const api = createMockDebugApi({ port: 0 });
let base = "";
beforeAll(async () => {
  base = `http://127.0.0.1:${await api.listen()}`;
});
afterAll(() => api.close());

const ctxFor = (url: string, token = "local-debug-token"): PanelCtx => ({
  sessionId: "t",
  env: { DEBUG_API_URL: url, DEBUG_API_TOKEN: token },
  fetch: (u, init) => fetch(u, init),
  onEvent: () => () => {},
  theme: "dark",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await sleep(25);
  }
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { Authorization: "Bearer local-debug-token", "content-type": "application/json" }, body: JSON.stringify(body) });

describe("DebugPoller", () => {
  it("polls incrementally with `since`, marks later arrivals fresh and reports auth errors", async () => {
    api.reset();
    let errors: Array<string | undefined> = [];
    const p = new DebugPoller({ baseUrl: base, token: "local-debug-token", fetch: (u, i) => fetch(u, i), onUpdate: () => {}, onError: (m) => errors.push(m) });
    await p.pollOnce();
    expect(p.receipts.size).toBe(2);
    expect(p.receipts.rows().every((r) => !r.fresh)).toBe(true);
    await post("/__mock/receipt", { decision: "DENY", amount_minor: 3100, rule_texts: ["Ask me before buying drinks."] });
    await p.pollOnce();
    expect(p.receipts.size).toBe(3);
    expect(p.receipts.rows()[0]).toMatchObject({ decision: "DENY", fresh: true, amount: "$31.00" });
    await p.pollOnce();
    expect(p.receipts.size).toBe(3); // nothing duplicated

    const bad = new DebugPoller({ baseUrl: base, token: "wrong", fetch: (u, i) => fetch(u, i), onUpdate: () => {}, onError: (m) => errors.push(m) });
    await bad.pollOnce();
    expect(errors.at(-1)).toMatch(/401/);
  });
});

describe("panel plugin", () => {
  it("renders the live feed, DENY badge, rule text, amounts and highlights a new rule", async () => {
    api.reset();
    const host = document.createElement("div");
    document.body.append(host);
    const cleanup = await panel.mount(host, ctxFor(base));
    const root = host.shadowRoot!;
    await until(() => root.querySelectorAll('[data-testid="feed-row"]').length >= 2);
    expect(root.querySelectorAll('[data-testid="rule-row"]').length).toBe(5);
    expect(root.querySelector('[data-new="true"]')).toBeNull();

    await post("/__mock/receipt", { decision: "DENY", title: "Held: drinks purchase", amount_minor: 3100, rule_ids: ["rule_x"], rule_texts: ["Ask me before buying drinks."] });
    await post("/__mock/rule", { rule_id: "rule_x", text: "Ask me before buying drinks." });
    const deny = await until(() => root.querySelector('[data-testid="feed-row"][data-decision="DENY"]') ?? undefined);
    expect(deny.querySelector('[data-testid="decision-badge"]')!.textContent).toBe("DENY");
    expect(deny.querySelector('[data-testid="amount"]')!.textContent).toBe("$31.00");
    expect(deny.querySelector('[data-testid="rule-text"]')!.textContent).toContain("Ask me before buying drinks.");
    expect(deny.classList.contains("fresh")).toBe(true);
    const fresh = await until(() => root.querySelector('[data-testid="rule-row"][data-new="true"]') ?? undefined);
    expect(fresh.textContent).toContain("NEW");
    expect(fresh.textContent).toContain("Ask me before buying drinks.");

    await (cleanup as () => void)();
  });

  it("shows an unreachable banner instead of crashing", async () => {
    const host = document.createElement("div");
    const cleanup = await panel.mount(host, ctxFor("http://127.0.0.1:1"));
    const err = await until(() => {
      const e = host.shadowRoot!.querySelector(".err") as HTMLElement | null;
      return e && !e.hidden ? e : undefined;
    });
    expect(err.textContent).toContain("127.0.0.1:1");
    await (cleanup as () => void)();
  });
});
