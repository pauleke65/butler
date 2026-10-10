import { ReceiptStore, RuleStore, type FeedRow, type RuleRow } from "./feed";
import type { DebugReceipt, DebugRule, Panel, PanelCtx } from "./types";

const DEFAULT_URL = "http://localhost:8085";
const DEFAULT_TOKEN = "local-debug-token";
const POLL_MS = 1000;
const FEED_ROWS = 5;

const CSS = `
:host{display:block}
*{box-sizing:border-box}
.wrap{font:13px/1.4 Figtree,"Amazon Ember",system-ui,sans-serif;color:#eceef2;padding:16px 16px 18px;-webkit-font-smoothing:antialiased}
.head{display:flex;align-items:center;gap:11px;margin:0 0 4px}
.mark{width:30px;height:30px;border-radius:9px;background:#ff7a1a;display:grid;place-items:center;flex:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 14px -6px rgba(255,122,26,.7)}
.mark i{width:9px;height:9px;border-radius:50%;background:#2a1204;box-shadow:0 0 0 2px rgba(42,18,4,.25)}
.mark.live i{animation:rec 1.6s ease-in-out infinite}
@keyframes rec{50%{opacity:.35}}
.title{font-size:15px;font-weight:650;letter-spacing:-.01em;line-height:1.15}
.bar{display:flex;align-items:center;gap:6px;color:#8a909c;font-size:12px}
.dot{display:none}.dot.off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff8f8f}
h3{margin:16px 0 8px;font-size:12px;font-weight:600;color:#b5bac4;display:flex;align-items:baseline;gap:6px}
h3 span{color:#7b818d;font-weight:500;font-variant-numeric:tabular-nums}
.feed,.rules{display:flex;flex-direction:column;gap:6px}
.row{padding:9px 11px 10px;border-radius:14px;background:#1b1e23;display:flex;flex-direction:column;gap:4px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.top{display:flex;align-items:center;gap:8px}
.badge{font:500 12px/1.2 Figtree,system-ui,sans-serif;flex:none}
.badge.allow{color:#7b818d}
.badge.deny{font-weight:700;background:#e5484d;color:#fff;padding:3px 8px;border-radius:99px}
.tool{flex:1;min-width:0;font:600 12.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d6d9df;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool small{font:500 11.5px Figtree,system-ui,sans-serif;color:#7b818d}
.amount{font-weight:600;font-size:13px;color:#eceef2;font-variant-numeric:tabular-nums;white-space:nowrap}
.rulet{color:#b5bac4;font-size:12.5px;line-height:1.35}
.meta{display:flex;flex-wrap:wrap;gap:2px 8px;color:#7b818d;font-size:11.5px}
.time{font-variant-numeric:tabular-nums}
.row.deny{background:#3a1519}
.row.deny .rulet{color:#ffd9dc}
.row.deny .tool{color:#fff}
.row.deny .meta{color:#c79197}
.row.fresh{animation:rise .42s cubic-bezier(.16,1,.3,1) both}
.row.deny.fresh{animation:rise .42s cubic-bezier(.16,1,.3,1) both,deny 2.4s cubic-bezier(.16,1,.3,1) both}
@keyframes rise{from{opacity:.3;transform:translateY(-8px)}to{opacity:1;transform:none}}
@keyframes deny{0%{background:#9b2230}100%{background:#3a1519}}
.rule{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:12px;background:#1b1e23;font-size:12.5px;line-height:1.35;color:#d6d9df}
.rule .text{flex:1}
.rule.inactive{opacity:.5}
.rule.new{background:#2a2622;color:#fff}
.rule.new.fresh{animation:newrule 2.4s cubic-bezier(.16,1,.3,1) both}
@keyframes newrule{0%{background:#6b3a14}100%{background:#2a2622}}
.tag{font:700 10px/1 Figtree,system-ui,sans-serif;letter-spacing:.04em;padding:4px 7px;border-radius:99px;background:#ff7a1a;color:#2a1204;flex:none}
.effect{font-size:11px;font-weight:600;padding:3px 8px;border-radius:99px;background:#24272d;color:#b5bac4;white-space:nowrap;flex:none}
.effect.never{background:#3a1a1f;color:#ff9a9a}.effect.ask_first{background:#33291a;color:#ffc56b}.effect.allow{background:#16302a;color:#6fd8a4}
.empty{color:#7b818d;font-size:12.5px;padding:4px 2px}
.err{margin:10px 0 0;padding:8px 10px;border-radius:12px;background:#3a1a1f;color:#ffd9dc;font-size:12px;word-break:break-word}
@media (prefers-reduced-motion:reduce){.row.fresh,.row.deny.fresh,.rule.new.fresh,.mark.live i{animation:none}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const EFFECT_LABEL: Record<string, string> = { ask_first: "Ask first", never: "Never", allow: "Allowed" };

export function renderFeedRow(r: FeedRow): HTMLElement {
  const row = el("div", `row ${r.decision === "DENY" ? "deny" : "allow"}${r.fresh ? " fresh" : ""}`);
  row.dataset.testid = "feed-row";
  row.dataset.decision = r.decision;
  const top = el("div", "top");
  // the DENY is the only filled mark on the card; allowed calls just say so
  const badge = el("span", `badge ${r.decision === "DENY" ? "deny" : "allow"}`, r.decision === "DENY" ? "Denied" : "Allowed");
  badge.dataset.testid = "decision-badge";
  const tool = el("span", "tool");
  tool.append(r.tool);
  if (r.target) tool.append(" ", el("small", "", r.target));
  tool.title = r.target ? `${r.target}___${r.tool}` : r.tool;
  top.append(tool, badge);
  if (r.amount) {
    const a = el("span", "amount", r.amount);
    a.dataset.testid = "amount";
    top.append(a);
  }
  const meta = el("div", "meta");
  meta.append(el("span", "", r.principal), el("span", "time", r.time));
  if (r.statusNote) meta.append(el("span", "", r.statusNote));
  if (r.matched) {
    const rule = el("div", "rulet", `“${r.ruleText}”`);
    rule.dataset.testid = "rule-text";
    row.append(top, rule, meta);
  } else {
    const none = el("span", "", r.ruleText);
    none.dataset.testid = "rule-text";
    meta.append(none);
    row.append(top, meta);
  }
  return row;
}

export function renderRuleRow(r: RuleRow, animate = false): HTMLElement {
  const row = el("div", `rule${r.isNew ? " new" : ""}${r.isNew && animate ? " fresh" : ""}${r.active ? "" : " inactive"}`);
  row.dataset.testid = "rule-row";
  row.dataset.new = String(r.isNew);
  if (r.isNew) row.append(el("span", "tag", "NEW"));
  row.append(el("span", "text", r.text), el("span", `effect ${r.effect}`, r.active ? (EFFECT_LABEL[r.effect] ?? r.effect) : r.status));
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
  chrome: "bare",
  mount(host, ctx) {
    const base = (ctx.env.DEBUG_API_URL ?? DEFAULT_URL).replace(/\/$/, "");
    const token = ctx.env.DEBUG_API_TOKEN ?? DEFAULT_TOKEN;
    const root = host.attachShadow({ mode: "open" });
    const style = el("style");
    style.textContent = CSS;
    const wrap = el("div", "wrap");
    // a flight recorder: recorder-orange mark, then the tape of decisions
    const head = el("div", "head");
    const mark = el("span", "mark");
    mark.append(el("i"));
    const names = el("div");
    const bar = el("div", "bar");
    const dot = el("span", "dot off");
    const status = el("span", "", "Connecting…");
    bar.append(dot, status);
    names.append(el("div", "title", "Black Box"), bar);
    head.append(mark, names);
    const err = el("div", "err");
    err.hidden = true;
    const feedTitle = el("h3", "", "Gateway decisions");
    const feedCount = el("span");
    feedTitle.append(feedCount);
    const feed = el("div", "feed");
    feed.dataset.testid = "feed";
    const rulesTitle = el("h3", "", "Rules in force");
    const ruleCount = el("span");
    rulesTitle.append(ruleCount);
    const rules = el("div", "rules");
    rules.dataset.testid = "rules";
    wrap.append(head, err, feedTitle, feed, rulesTitle, rules);
    root.append(style, wrap);

    // Animate each arrival once; repaints after that keep the row's colour but not the motion.
    const shownRows = new Set<string>();
    const shownRules = new Set<string>();
    const attention = (tone: "alert" | "info") => host.dispatchEvent(new CustomEvent("panel-attention", { bubbles: true, composed: true, detail: { tone } }));
    const paintRules = () => {
      const rr = poller.rules.rows();
      let fresh = false;
      rules.replaceChildren(
        ...(rr.length
          ? rr.map((r) => {
              const first = r.isNew && !shownRules.has(r.id);
              if (first) {
                shownRules.add(r.id);
                fresh = true;
              }
              return renderRuleRow(r, first);
            })
          : [el("div", "empty", "No rules loaded.")]),
      );
      ruleCount.textContent = String(poller.rules.activeCount);
      return fresh;
    };

    let lastError: string | undefined;
    const poller = new DebugPoller({
      baseUrl: base,
      token,
      fetch: (u, i) => ctx.fetch(u, i),
      onError: (m) => {
        lastError = m;
      },
      onUpdate: () => {
        const rows = poller.receipts.rows(FEED_ROWS).map((r) => {
          const first = r.fresh && !shownRows.has(r.id);
          shownRows.add(r.id);
          return { ...r, fresh: first };
        });
        feed.replaceChildren(...(rows.length ? rows.map(renderFeedRow) : [el("div", "empty", "No actions yet. Every tool call the agent makes shows up here with the gateway's decision.")]));
        const newRule = paintRules();
        if (rows.some((r) => r.fresh && r.decision === "DENY")) attention("alert");
        else if (rows.some((r) => r.fresh) || newRule) attention("info");
        dot.className = lastError ? "dot off" : "dot";
        status.textContent = lastError ? "Debug API unreachable" : "Recording every gateway decision";
        mark.className = lastError ? "mark" : "mark live";
        feedCount.textContent = String(poller.receipts.size);
        err.hidden = !lastError;
        err.textContent = lastError ? `${base}: ${lastError}` : "";
      },
    });
    poller.start();
    // keep the "NEW" highlight accurate without waiting for the next poll
    const tick = setInterval(paintRules, 2500);
    return () => {
      poller.stop();
      clearInterval(tick);
      root.replaceChildren();
    };
  },
};

export default panel;
