/** Small shared components: status pills, the authority line, Alexa pill buttons, error and loading states. */
import type { ComponentChildren } from "preact";
import type { Money as MoneyT, NeedStatus } from "@butler/contracts";
import { Alert, ArrowRight } from "./icons";
import type { Receipt } from "./types";

const NEED_LABEL: Record<NeedStatus, string> = {
  doing: "Working",
  done: "Done",
  needs_you: "Needs you",
  blocked: "Blocked",
  skipped: "Skipped",
};

/** A price as the hero number: the currency sign set small and raised, the amount large and light. */
export function Money({ m, class: cls = "price" }: { m: MoneyT | undefined; class?: string }) {
  if (!m) return null;
  const dollars = m.amount_minor / 100;
  const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2 }).formatToParts(dollars);
  return (
    <span class={cls}>
      {parts.map((p, i) => (p.type === "currency" ? <span key={i} class="cur">{p.value}</span> : p.value))}
    </span>
  );
}

export function NeedChip({ status }: { status: NeedStatus }) {
  return <span class={`chip ${status}`}>{NEED_LABEL[status]}</span>;
}

export function Chip({ kind, children }: { kind: string; children: ComponentChildren }) {
  return <span class={`chip ${kind}`}>{children}</span>;
}

export function SimulatedBadge() {
  return (
    <span class="chip simulated" title="This provider is simulated; nothing real was booked or bought">
      Simulated
    </span>
  );
}

export type AuthorityKind = "allowed" | "held" | "blocked" | "failed";

/** Allowed / Held / Blocked, plus the rule that applied. */
export function authorityOf(r: Receipt): { kind: AuthorityKind; label: string; rule?: string } {
  const rule = r.authority.rule_texts[0];
  const withRule = rule ? { rule } : {};
  if (r.status === "held_for_approval") return { kind: "held", label: "Held", ...withRule };
  if (r.status === "blocked") return { kind: "blocked", label: "Blocked", ...withRule };
  if (r.status === "failed") return { kind: "failed", label: "Failed" };
  return { kind: "allowed", label: "Allowed", ...withRule };
}

/** "Allowed by “Ask me before spending more than 50 dollars”" / "Held by …" / "Allowed: you approved it". */
export function AuthorityLine({ receipt }: { receipt: Receipt }) {
  const a = authorityOf(receipt);
  const approved = receipt.authority.principal === "approval-executor" && a.kind === "allowed";
  const by = approved ? "you approved it" : a.rule ? `by “${stripDot(a.rule)}”` : a.kind === "allowed" ? "no rule needed" : "";
  return (
    <p class="row tight wrap" style={{ alignItems: "baseline" }}>
      <span class={`chip ${a.kind}`}>{a.label}</span>
      {by ? <span class="meta">{by}</span> : null}
    </p>
  );
}

export function stripDot(s: string): string {
  return s.replace(/[.!?]+$/, "");
}

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  variant?: "primary" | "danger" | "quiet" | "cta";
  icon?: ComponentChildren;
  busy?: boolean;
  disabled?: boolean;
  block?: boolean;
  pressed?: boolean;
  label?: string;
}) {
  const cls = ["btn", props.variant ?? "", props.block ? "block" : ""].filter(Boolean).join(" ");
  const lead = props.variant === "cta" ? <span class="arrow">{props.icon ?? <ArrowRight size={13} />}</span> : props.icon;
  return (
    <button
      type="button"
      class={cls}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy ? "true" : undefined}
      aria-pressed={props.pressed}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {lead}
      {props.busy ? "Working…" : props.children}
    </button>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div class="error" role="alert">
      <Alert size={16} />
      <span>{message}</span>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div class="view" aria-busy="true" aria-label="Loading">
      <div class="card">
        <div class="skeleton" style={{ width: "45%", height: "calc(22px * var(--u))" }} />
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} class="skeleton" style={{ width: `${88 - i * 14}%` }} />
        ))}
      </div>
    </div>
  );
}
