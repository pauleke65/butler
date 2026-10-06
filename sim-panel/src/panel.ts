import { ReceiptStore, RuleStore, type FeedRow, type RuleRow } from "./feed";
import type { DebugReceipt, DebugRule, Panel, PanelCtx } from "./types";

const DEFAULT_URL = "http://localhost:8085";
const DEFAULT_TOKEN = "local-debug-token";
const POLL_MS = 1000;

const CSS = `
:host{display:block}
*{box-sizing:border-box}
.wrap{font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#e7edf8;padding:8px 12px 12px}
.bar{display:flex;align-items:center;gap:8px;color:#8ea3c4;font-size:11px;margin:2px 0 8px}
.dot{width:8px;height:8px;border-radius:50%;background:#34d399}.dot.off{background:#f87171}
h3{margin:12px 0 6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8ea3c4;font-weight:600}
.feed{display:flex;flex-direction:column;gap:4px}
.row{display:grid;grid-template-columns:auto 1fr auto;gap:1px 10px;padding:5px 10px;border-radius:10px;background:#111a2e;border:1px solid #1c2a47;align-items:center}
.row.deny{background:rgba(248,113,113,.10);border-color:rgba(248,113,113,.45)}
.row.fresh{animation:slide .35s ease-out}
.row.deny.fresh{animation:slide .35s ease-out,flash 1.2s ease-out}
@keyframes slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes flash{0%,100%{box-shadow:0 0 0 0 rgba(248,113,113,0)}20%,60%{box-shadow:0 0 0 3px rgba(248,113,113,.9);background:rgba(248,113,113,.45)}}
@media (prefers-reduced-motion:reduce){.row.fresh,.row.deny.fresh{animation:none}.rule.new{animation:none}}
.badge{font-weight:700;font-size:11px;padding:2px 8px;border-radius:6px;letter-spacing:.04em}
.badge.allow{background:rgba(52,211,153,.16);color:#6ee7b7}.badge.deny{background:#ef4444;color:#fff}
.tool{font:600 12px ui-monospace,Menlo,monospace;color:#f1f5f9}.tool small{color:#8ea3c4;font-weight:400}
.meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 10px;color:#9fb0cc;font-size:11px}
.chip{background:rgba(255,255,255,.06);border-radius:5px;padding:0 6px;font-size:10px;color:#b6c4dc}
.amount{font:700 13px ui-monospace,Menlo,monospace;color:#fcd34d;white-space:nowrap}
.rulet{color:#cbd5e1;font-style:italic}.time{color:#6b7fa3;font:11px ui-monospace,Menlo,monospace}
.empty{color:#6b7fa3;padding:6px 2px}
.rules{display:flex;flex-direction:column;gap:5px}
.rule{display:flex;gap:8px;align-items:center;padding:6px 9px;border-radius:8px;background:#0f1730;border:1px solid #1c2a47}
.rule.inactive{opacity:.55}
.rule.new{border-color:#38bdf8;background:rgba(56,189,248,.14);animation:glow 1.6s ease-in-out 3}
@keyframes glow{50%{box-shadow:0 0 0 3px rgba(56,189,248,.55)}}
.tag{font-size:9px;font-weight:700;letter-spacing:.08em;padding:1px 6px;border-radius:5px;background:#38bdf8;color:#04283a}
.effect{font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.07);color:#b6c4dc;white-space:nowrap}
.effect.never{background:rgba(248,113,113,.2);color:#fca5a5}.effect.ask_first{background:rgba(251,191,36,.16);color:#fcd34d}
.err{margin:6px 0;padding:6px 8px;border-radius:8px;background:rgba(248,113,113,.14);color:#fecaca}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderFeedRow(r: FeedRow): HTMLElement {
  const row = el("div", `row ${r.decision === "DENY" ? "deny" : "allow"}${r.fresh ? " fresh" : ""}`);
  row.dataset.testid = "feed-row";
  row.dataset.decision = r.decision;
  const tool = el("div", "tool");
  tool.append(r.tool);
  if (r.target) tool.append(" ", Object.assign(el("small", "", `· ${r.target}`)));
  const badge = el("span", `badge ${r.decision === "DENY" ? "deny" : "allow"}`, r.decision);
  badge.dataset.testid = "decision-badge";
  const right = el("div");
  right.style.cssText = "display:flex;gap:8px;align-items:center";
  if (r.amount) {
    const a = el("span", "amount", r.amount);
    a.dataset.testid = "amount";
    right.append(a);
  }
  right.append(badge);
  const left = el("div");
  left.append(tool);
  const t = el("span", "time", r.time);
  row.append(t, left, right);
  const meta = el("div", "meta");
  const rule = el("span", "rulet", `“${r.ruleText}”`);
  rule.dataset.testid = "rule-text";
  meta.append(el("span", "chip", r.principal), rule);
  if (r.statusNote) meta.append(el("span", "chip", r.statusNote));
  row.append(meta);
  return row;
}

export function renderRuleRow(r: RuleRow): HTMLElement {
  const row = el("div", `rule${r.isNew ? " new" : ""}${r.active ? "" : " inactive"}`);
  row.dataset.testid = "rule-row";
  row.dataset.new = String(r.isNew);
  if (r.isNew) row.append(el("span", "tag", "NEW"));
  const text = el("span", "", r.text);
  text.style.flex = "1";
  row.append(text, el("span", `effect ${r.effect}`, r.effect.replace("_", " ")));
  if (!r.active) row.append(el("span", "effect", r.status));
  return row;
}

export interface PollerOptions {
  baseUrl: string;
  token: string;
  fetch: PanelCtx["fetch"];
  intervalMs?: number;
  onUpdate(): void;
  onError(msg: string | undefined): void;
}

/** Polls /receipts (incrementally via `since`) and /rules. Exposed for tests. */
export class DebugPoller {
  readonly receipts = new ReceiptStore();
  readonly rules = new RuleStore();
  lastOkAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy = false;

  constructor(private readonly o: PollerOptions) {}

  private headers() {
    return { Authorization: `Bearer ${this.o.token}`, Accept: "application/json" };
  }

  async pollOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const since = this.receipts.lastActionId ? `&since=${encodeURIComponent(this.receipts.lastActionId)}` : "";
      const [rcp, rul] = await Promise.all([
        this.o.fetch(`${this.o.baseUrl}/receipts?limit=50${since}`, { headers: this.headers() }),
        this.o.fetch(`${this.o.baseUrl}/rules`, { headers: this.headers() }),
      ]);
      if (!rcp.ok) throw new Error(`/receipts ${rcp.status}`);
      if (!rul.ok) throw new Error(`/rules ${rul.status}`);
      const rb = (await rcp.json()) as { receipts?: DebugReceipt[] };
      const ub = (await rul.json()) as { rules?: DebugRule[] };
      this.receipts.merge(rb.receipts ?? []);
      this.rules.update(ub.rules ?? []);
      this.lastOkAt = Date.now();
      this.o.onError(undefined);
    } catch (err) {
      this.o.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
      this.o.onUpdate();
    }
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      await this.pollOnce();
      if (!this.stopped) this.timer = setTimeout(loop, this.o.intervalMs ?? POLL_MS);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** The Butler Black Box panel. */
export const panel: Panel = {
  id: "butler-black-box",
  title: "Butler Black Box",
  mount(host, ctx) {
    const base = (ctx.env.DEBUG_API_URL ?? DEFAULT_URL).replace(/\/$/, "");
    const token = ctx.env.DEBUG_API_TOKEN ?? DEFAULT_TOKEN;
    const root = host.attachShadow({ mode: "open" });
    const style = el("style");
    style.textContent = CSS;
    const wrap = el("div", "wrap");
    const bar = el("div", "bar");
    const dot = el("span", "dot off");
    const status = el("span", "", "connecting…");
    bar.append(dot, status);
    const err = el("div", "err");
    err.hidden = true;
    const feedTitle = el("h3", "", "Policy decisions (live)");
    const feed = el("div", "feed");
    feed.dataset.testid = "feed";
    const rulesTitle = el("h3", "", "Active rules");
    const rules = el("div", "rules");
    rules.dataset.testid = "rules";
    wrap.append(bar, err, feedTitle, feed, rulesTitle, rules);
    root.append(style, wrap);

    let lastError: string | undefined;
    const poller = new DebugPoller({
      baseUrl: base,
      token,
      fetch: (u, i) => ctx.fetch(u, i),
      onError: (m) => {
        lastError = m;
      },
      onUpdate: () => {
        const rows = poller.receipts.rows(20);
        feed.replaceChildren(...(rows.length ? rows.map(renderFeedRow) : [el("div", "empty", "No actions yet. Decisions appear here the moment the agent calls a tool.")]));
        const rr = poller.rules.rows();
        rules.replaceChildren(...(rr.length ? rr.map(renderRuleRow) : [el("div", "empty", "No rules loaded.")]));
        dot.className = lastError ? "dot off" : "dot";
        status.textContent = lastError ? "debug API unreachable" : `live · ${poller.receipts.size} receipts · ${poller.rules.activeCount} active rules · polling 1 s`;
        err.hidden = !lastError;
        err.textContent = lastError ? `${base}: ${lastError}` : "";
      },
    });
    poller.start();
    // keep "NEW" highlight accurate without waiting for the next poll
    const tick = setInterval(() => {
      const rr = poller.rules.rows();
      rules.replaceChildren(...rr.map(renderRuleRow));
    }, 2500);
    return () => {
      poller.stop();
      clearInterval(tick);
      root.replaceChildren();
    };
  },
};

export default panel;
