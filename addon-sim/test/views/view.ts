/**
 * A tiny generic MCP App view used by the test servers. It renders whatever `structuredContent`
 * it receives (plan / carousel / receipt / list) and exercises the host: tools/call from a button,
 * display-mode request, size changes, theme.
 */
import { App } from "@modelcontextprotocol/ext-apps";

type Obj = Record<string, unknown>;
const app = new App({ name: "addon-sim-test-view", version: "0.1.0" }, {}, { autoResize: true });
const root = document.getElementById("root")!;
let lastInput: Obj = {};
let lastResult: Obj | undefined;
let mode = "inline";

const css = `
:root{color-scheme:dark light;--bg:#0f172a;--fg:#e2e8f0;--card:#1e293b;--accent:#38bdf8;--muted:#94a3b8}
@media (prefers-color-scheme: light){:root.auto{--bg:#fff;--fg:#0f172a;--card:#f1f5f9;--muted:#475569}}
*{box-sizing:border-box}body{margin:0;font:24px/1.35 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:38px;margin:0 0 12px}h2{font-size:24px;margin:0}small,.muted{color:var(--muted);font-size:18px}
.wrap{padding:20px}.row{display:flex;gap:16px;overflow-x:auto}.card{background:var(--card);border-radius:16px;padding:16px;min-width:260px;flex:1}
.chip{display:inline-block;padding:2px 10px;border-radius:999px;background:#334155;font-size:16px;margin-left:8px}
.chip.done{background:#166534}.chip.needs_you{background:#92400e}.chip.doing{background:#1d4ed8}
button{font:inherit;font-size:20px;border:0;border-radius:12px;padding:10px 18px;background:var(--accent);color:#082f49;margin:10px 8px 0 0;cursor:pointer}
button.ghost{background:transparent;color:var(--accent);border:2px solid var(--accent)}
.badge{color:#fbbf24;font-size:16px}pre{white-space:pre-wrap;font-size:14px}
`;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function money(m: unknown): string {
  const mm = m as { amount_minor?: number } | undefined;
  return mm?.amount_minor !== undefined ? `$${(mm.amount_minor / 100).toFixed(2)}` : "";
}

function render(sc: Obj): void {
  const parts: string[] = [`<style>${css}</style><div class="wrap" data-testid="view" data-mode="${mode}">`];
  const plan = sc.plan as Obj | undefined;
  const decisions = (sc.pending_decisions as Obj[] | undefined) ?? (sc.decision ? [sc.decision as Obj] : []);
  const receipt = sc.receipt as Obj | undefined;
  const actions = sc.actions as Obj[] | undefined;
  const rule = sc.rule as Obj | undefined;
  parts.push(`<small class="muted">${esc((app.getHostContext() as Obj | undefined)?.theme ?? "")} · ${esc(mode)}</small>`);
  if (plan) {
    parts.push(`<h1>${esc(plan.title)}</h1><div data-testid="needs">`);
    for (const n of (plan.needs as Obj[]) ?? []) {
      parts.push(`<div>${esc(n.label)} <span class="chip ${esc(n.status)}">${esc(n.status)}</span></div>`);
    }
    parts.push("</div>");
  }
  const first = decisions[0];
  if (first) {
    parts.push(`<h1>${esc(first.question)}</h1><div class="row" data-testid="carousel">`);
    for (const o of (first.options as Obj[]) ?? []) {
      parts.push(
        `<div class="card"><h2>${esc(o.title)}</h2><div class="muted">${esc(o.subtitle)}</div><div>${esc(money(o.price))}</div><div class="muted">${esc(o.tradeoff)}</div>` +
          `<button data-choose="${esc(o.option_id)}" data-decision="${esc(first.decision_id)}">Choose</button></div>`,
      );
    }
    parts.push("</div>");
  }
  if (receipt) {
    const auth = receipt.authority as Obj | undefined;
    parts.push(
      `<h1>${esc(receipt.title)}</h1><div data-testid="receipt">${esc(money(receipt.cost))} <span class="badge">${esc(auth?.decision)} by ${esc(
        ((auth?.rule_texts as string[]) ?? [])[0] ?? auth?.principal,
      )}</span></div><div class="muted">${esc(((receipt.reasons as string[]) ?? [])[0])}</div>`,
    );
  }
  if (rule) parts.push(`<h1>${esc(rule.text)}</h1><div class="muted">${esc(rule.effect)} · ${esc(rule.policy_status)}</div>`);
  if (actions) {
    parts.push(`<h1>Actions</h1><div class="row">`);
    for (const a of actions) parts.push(`<div class="card"><h2>${esc(a.title)}</h2><div class="muted">${esc(((a.reasons as string[]) ?? [])[0])}</div></div>`);
    parts.push(`</div><button data-fullscreen="1">${mode === "fullscreen" ? "Exit full screen" : "See more"}</button>`);
  }
  if (!plan && !first && !receipt && !rule && !actions) {
    // "public example server" shape: only text content or arbitrary structured data
    parts.push(`<h1>${esc(sc.title ?? "Result")}</h1><pre data-testid="raw">${esc(JSON.stringify(sc, null, 2))}</pre>`);
  }
  parts.push(`<button class="ghost" data-ping="1">Call app tool</button><span class="muted" data-testid="status"></span>`);
  parts.push("</div>");
  root.innerHTML = parts.join("");
}

function setStatus(text: string): void {
  const el = root.querySelector('[data-testid="status"]');
  if (el) el.textContent = text;
}

root.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.choose) {
    setStatus("calling answer_decision...");
    const res = await app.callServerTool({ name: "answer_decision", arguments: { decision_id: t.dataset.decision, choice: t.dataset.choose } });
    const sc = (res.structuredContent ?? {}) as Obj;
    lastResult = sc;
    render(sc);
    setStatus(`answer_decision -> ${String(sc.spoken_summary ?? "ok")}`);
  } else if (t.dataset.fullscreen) {
    const next = mode === "fullscreen" ? "inline" : "fullscreen";
    const r = await app.requestDisplayMode({ mode: next });
    mode = r.mode;
    if (lastResult) render(lastResult);
    setStatus(`display mode: ${r.mode}`);
  } else if (t.dataset.ping) {
    const res = await app.callServerTool({ name: "get_plan", arguments: { plan_id: String((lastInput as Obj).plan_id ?? "plan_mock") } });
    setStatus(`get_plan ${res.isError ? "failed" : "ok"}`);
  }
});

app.ontoolinput = (p) => {
  lastInput = (p.arguments ?? {}) as Obj;
};
app.ontoolresult = (r) => {
  const sc = (r.structuredContent ?? {}) as Obj;
  lastResult = sc;
  const delay = typeof sc._view_delay_ms === "number" ? sc._view_delay_ms : 0;
  setTimeout(() => render(sc), delay);
};
app.onhostcontextchanged = (ctx) => {
  const c = ctx as Obj;
  if (typeof c.displayMode === "string") mode = c.displayMode;
  if (lastResult) render(lastResult);
};
app.onteardown = async () => ({});

void app.connect().then(() => {
  const ctx = app.getHostContext() as Obj | undefined;
  if (typeof ctx?.displayMode === "string") mode = ctx.displayMode;
  render({ title: "Waiting for result..." });
});
