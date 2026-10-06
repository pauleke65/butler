/** Small shared components: status chips, authority badges, buttons, error and skeleton states. */
import type { ComponentChildren } from "preact";
import type { NeedStatus } from "@butler/contracts";
import type { Receipt } from "./types";

const NEED_LABEL: Record<NeedStatus, string> = {
  doing: "Working",
  done: "Done",
  needs_you: "Needs you",
  blocked: "Blocked",
  skipped: "Skipped",
};

export function NeedChip({ status }: { status: NeedStatus }) {
  return <span class={`chip ${status}`}>{NEED_LABEL[status]}</span>;
}

export function Chip({ kind, children }: { kind: string; children: ComponentChildren }) {
  return <span class={`chip ${kind}`}>{children}</span>;
}

export function SimulatedBadge() {
  return (
    <span class="badge simulated" title="This provider is simulated; nothing real was booked or bought">
      Simulated
    </span>
  );
}

/** ALLOWED / HELD / BLOCKED (+ the rule that applied). */
export function authorityOf(r: Receipt): { kind: "allowed" | "held" | "blocked" | "failed" | "undone"; label: string; rule?: string } {
  const rule = r.authority.rule_texts[0];
  if (r.status === "undone") return { kind: "allowed", label: "ALLOWED", ...(rule ? { rule } : {}) };
  if (r.status === "held_for_approval") return { kind: "held", label: "HELD", ...(rule ? { rule } : {}) };
  if (r.status === "blocked") return { kind: "blocked", label: "BLOCKED", ...(rule ? { rule } : {}) };
  if (r.status === "failed") return { kind: "failed", label: "FAILED" };
  return { kind: "allowed", label: "ALLOWED", ...(rule ? { rule } : {}) };
}

export function AuthorityBadge({ receipt }: { receipt: Receipt }) {
  const a = authorityOf(receipt);
  const by = receipt.authority.principal === "approval-executor" ? "approved by you" : a.rule;
  return (
    <span class="row wrap" style={{ gap: "10px" }}>
      <span class={`badge ${a.kind}`}>{a.label}</span>
      {by ? <span class="meta">{a.kind === "allowed" && receipt.authority.principal === "approval-executor" ? "by your approval" : `by ${stripDot(by)}`}</span> : null}
    </span>
  );
}

export function stripDot(s: string): string {
  return s.replace(/[.!?]+$/, "");
}

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  variant?: "primary" | "danger" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  block?: boolean;
  pressed?: boolean;
  label?: string;
}) {
  const cls = ["btn", props.variant ?? "", props.block ? "block" : ""].filter(Boolean).join(" ");
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
      {props.busy ? "Working…" : props.children}
    </button>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div class="error" role="alert">
      {message}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div class="view" aria-busy="true" aria-label="Loading">
      <div class="skeleton" style={{ width: "50%", height: "44px" }} />
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} class="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Say({ text }: { text?: string | undefined }) {
  return text ? <p class="say">{text}</p> : null;
}
