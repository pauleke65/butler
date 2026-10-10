/** ui://butler/receipt: one action, why it happened, which rule applied, and an Undo when it can be undone. */
import { useState } from "preact/hooks";
import { fmtWhen, TOOL_LABEL } from "../format";
import { ArrowLeft, Check, Info, Undo } from "../icons";
import type { Data, HostApi, Receipt, ViewProps } from "../types";
import { AuthorityLine, Button, Chip, ErrorBox, Money, SimulatedBadge, Skeleton, stripDot } from "../ui";

function Why({ r }: { r: Receipt }) {
  const rulesTitle = r.authority.decision === "DENY" ? "Rule that stopped it" : "Rule that applied";
  return (
    <section class="why rise" aria-label="Why Butler did this">
      <div class="stack why-col">
        {r.reasons.length > 0 ? (
          <div class="stack">
            <h3>Why</h3>
            <ul class="plain stack body2">
              {r.reasons.map((x) => (
                <li key={x} class="reason">{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.authority.rule_texts.length > 0 ? (
          <div class="stack">
            <h3>{rulesTitle}</h3>
            <p class="body2">“{stripDot(r.authority.rule_texts.join(" "))}”</p>
          </div>
        ) : null}
      </div>
      <div class="stack why-col">
        {r.alternatives.length > 0 ? (
          <div class="stack">
            <h3>Also considered</h3>
            <ul class="plain stack">
              {r.alternatives.map((a) => (
                <li key={a.option} class="stack alt">
                  <span class="body2">{a.option}</span>
                  <span class="meta">{a.rejected_because}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.context_used.length > 0 ? (
          <div class="stack">
            <h3>What I used</h3>
            <p class="meta">{r.context_used.join(" · ")}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function ReceiptCard(props: {
  receipt: Receipt;
  host: HostApi;
  /** Called when Undo produced a new receipt. */
  onUndone?: (undo: Receipt, original: Receipt) => void;
  startOpen?: boolean;
  onBack?: () => void;
}) {
  const { host } = props;
  const [receipt, setReceipt] = useState<Receipt>(props.receipt);
  const [open, setOpen] = useState(props.startOpen ?? false);
  const [busy, setBusy] = useState<"why" | "undo" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const why = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    setBusy("why");
    const res = await host.call<Data & { receipt?: Receipt }>("explain_action", { action_id: receipt.action_id });
    setBusy(undefined);
    if (res.ok && res.data.receipt) setReceipt(res.data.receipt);
  };

  const undo = async () => {
    setBusy("undo");
    setError(undefined);
    const res = await host.call<Data & { original?: Receipt; undo?: Receipt }>("undo_action", { action_id: receipt.action_id });
    setBusy(undefined);
    if (!res.ok) return setError(res.message);
    if (res.data.original) setReceipt(res.data.original);
    setNote(res.data.spoken_summary);
    if (res.data.undo && res.data.original) props.onUndone?.(res.data.undo, res.data.original);
  };

  const r = receipt;
  const canUndo = r.reversible && r.status === "executed";
  const reason = r.reasons[0];
  const kind = TOOL_LABEL[r.action.tool];

  return (
    <article class="card receipt" aria-label={r.title}>
      <header>
        <div class="stack">
          <h1>{r.title}</h1>
          <p class="sub">{[kind, fmtWhen(r.created_at, host.timeZone)].filter(Boolean).join(" · ")}</p>
        </div>
        <Money m={r.cost} />
      </header>
      {reason && !open ? <p class="dim">{reason}</p> : null}
      <div class="row tight wrap">
        <AuthorityLine receipt={r} />
        {r.simulated ? <SimulatedBadge /> : null}
        {r.status === "undone" ? <Chip kind="undone">Undone</Chip> : null}
      </div>
      <div class="tear" aria-hidden="true" />
      {open ? <Why r={r} /> : null}
      {error ? <ErrorBox message={error} /> : null}
      {note ? (
        <div class="notice good row tight" role="status">
          <Check size={15} />
          <span>{note}</span>
        </div>
      ) : null}
      <div class="row tight wrap">
        {props.onBack ? (
          <Button variant="quiet" icon={<ArrowLeft size={13} />} onClick={props.onBack}>
            Back
          </Button>
        ) : null}
        <Button icon={<Info size={14} />} onClick={why} busy={busy === "why" && !open} pressed={open}>
          {open ? "Hide why" : "Why?"}
        </Button>
        {canUndo ? (
          <Button variant="danger" icon={<Undo size={14} />} onClick={undo} busy={busy === "undo"}>
            Undo
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function ReceiptView({ data, error, host }: ViewProps) {
  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton />;

  const undo = data["undo"] as Receipt | undefined;
  const original = data["original"] as Receipt | undefined;
  const receipt = (undo ?? data["receipt"]) as Receipt | undefined;

  if (!receipt) {
    // e.g. answer_decision rejected: no receipt, just the outcome
    return (
      <div class="view">
        <div class="notice">{data.spoken_summary}</div>
      </div>
    );
  }
  return (
    <div class="view">
      <ReceiptCard receipt={receipt} host={host} startOpen={Boolean(data["receipt"] && !undo && receipt.alternatives.length > 0)} />
      {undo && original ? <p class="meta on-canvas">Undid: {original.title}</p> : null}
    </div>
  );
}
