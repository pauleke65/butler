import type { DebugReceipt, DebugRule } from "./types";

export interface FeedRow {
  id: string;
  time: string;
  target: string;
  tool: string;
  principal: string;
  decision: "ALLOW" | "DENY";
  statusNote?: string;
  ruleText: string;
  /** a rule (not the default) decided this call */
  matched: boolean;
  amount?: string;
  title: string;
  /** arrived after the panel's first poll: flashes (DENY) / slides in */
  fresh: boolean;
}

/** "Supplies___checkout" -> { target: "Supplies", tool: "checkout" } (AgentCore Gateway naming). */
export function splitTool(name: string): { target: string; tool: string } {
  const i = name.indexOf("___");
  return i > 0 ? { target: name.slice(0, i), tool: name.slice(i + 3) } : { target: "", tool: name };
}

/** Money is always integer minor units + ISO currency (contracts section 1): 4200 USD -> "$42.00". */
export function formatAmount(amountMinor: number | undefined, currency = "USD"): string | undefined {
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return undefined;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

export function receiptAmount(r: DebugReceipt): string | undefined {
  if (r.cost) return formatAmount(r.cost.amount_minor, r.cost.currency);
  const a = r.action?.args?.amount_minor;
  return typeof a === "number" ? formatAmount(a, "USD") : undefined;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

export function toRow(r: DebugReceipt, fresh: boolean): FeedRow {
  const { target, tool } = splitTool(r.action?.tool ?? "");
  const texts = r.authority?.rule_texts ?? [];
  const ids = r.authority?.rule_ids ?? [];
  return {
    id: r.action_id,
    time: clock(r.created_at),
    target,
    tool,
    principal: r.authority?.principal ?? "?",
    decision: r.authority?.decision ?? "ALLOW",
    statusNote: r.status === "executed" ? undefined : r.status.replace(/_/g, " "),
    ruleText: texts[0] ?? (ids[0] ? ids[0] : r.authority?.decision === "DENY" ? "denied by policy" : "no rule matched"),
    matched: Boolean(texts[0] ?? ids[0]),
    amount: receiptAmount(r),
    title: r.title,
    fresh,
  };
}

/** Receipts keyed by id. `merge` returns which ids are new (so DENY rows can flash exactly once). */
export class ReceiptStore {
  private byId = new Map<string, DebugReceipt>();
  private primed = false;
  readonly freshIds = new Set<string>();
  lastActionId: string | undefined;

  merge(receipts: DebugReceipt[]): string[] {
    const added: string[] = [];
    for (const r of receipts) {
      if (!this.byId.has(r.action_id)) {
        added.push(r.action_id);
        if (this.primed) this.freshIds.add(r.action_id);
      }
      this.byId.set(r.action_id, r);
      if (!this.lastActionId || r.action_id > this.lastActionId) this.lastActionId = r.action_id;
    }
    this.primed = true;
    return added;
  }

  /** Newest first. */
  rows(limit = 30): FeedRow[] {
    return [...this.byId.values()]
      .sort((a, b) => (a.action_id < b.action_id ? 1 : a.action_id > b.action_id ? -1 : 0))
      .slice(0, limit)
      .map((r) => toRow(r, this.freshIds.has(r.action_id)));
  }

  get size(): number {
    return this.byId.size;
  }
}

export interface RuleRow {
  id: string;
  text: string;
  effect: string;
  status: string;
  active: boolean;
  isNew: boolean;
  fromCorrection: boolean;
}

/** Tracks rules across polls; rules that show up (or become active) after the first poll are `isNew` for a while. */
export class RuleStore {
  private seen = new Map<string, { active: boolean; firstSeenAt: number; becameActiveAt?: number }>();
  private primed = false;
  private rules: DebugRule[] = [];
  constructor(private readonly highlightMs = 10_000) {}

  update(rules: DebugRule[], now = Date.now()): void {
    for (const r of rules) {
      const prev = this.seen.get(r.rule_id);
      if (!prev) {
        this.seen.set(r.rule_id, { active: r.active, firstSeenAt: this.primed ? now : 0, becameActiveAt: this.primed && r.active ? now : undefined });
      } else if (!prev.active && r.active) {
        prev.active = true;
        prev.becameActiveAt = this.primed ? now : undefined;
      }
    }
    this.primed = true;
    this.rules = rules;
  }

  rows(now = Date.now()): RuleRow[] {
    const rows = this.rules
      .map((r) => {
        const s = this.seen.get(r.rule_id);
        const t = Math.max(s?.firstSeenAt ?? 0, s?.becameActiveAt ?? 0);
        return {
          id: r.rule_id,
          text: r.text,
          effect: r.effect,
          status: r.policy_status,
          active: r.active,
          isNew: t > 0 && now - t < this.highlightMs,
          fromCorrection: r.origin?.type === "correction",
          created: r.created_at,
        };
      })
      // active first, then newest
      .sort((a, b) => Number(b.active) - Number(a.active) || (a.created < b.created ? 1 : -1));
    return rows.map(({ created: _c, ...rest }) => rest);
  }

  get activeCount(): number {
    return this.rules.filter((r) => r.active).length;
  }
}
