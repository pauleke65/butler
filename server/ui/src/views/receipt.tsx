/** ui://butler/receipt: one action, why it happened, which rule applied, and an Undo when it can be undone. */
import { useState } from "preact/hooks";
import { fmtMoney, fmtWhen } from "../format";
import type { Data, HostApi, Receipt, ViewProps } from "../types";
import { AuthorityBadge, Button, Chip, ErrorBox, Say, SimulatedBadge, Skeleton } from "../ui";

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

  return (
    <article class="card" aria-label={r.title}>
      <div class="row spread wrap">
        <div class="row wrap grow">
          <h1>{r.title}</h1>
          {r.simulated ? <SimulatedBadge /> : null}
          {r.status === "undone" ? <Chip kind="undone">Undone</Chip> : null}
        </div>
        {r.cost ? <div class="price">{fmtMoney(r.cost)}</div> : null}
      </div>
      {reason ? <p>{reason}</p> : null}
      <AuthorityBadge receipt={r} />
      <div class="row wrap">
        <Button onClick={why} busy={busy === "why" && !open} pressed={open}>
          {open ? "Hide why" : "Why?"}
        </Button>
        {canUndo ? (
          <Button variant="danger" onClick={undo} busy={busy === "undo"}>
            Undo
          </Button>
        ) : null}
        {props.onBack ? (
          <Button variant="ghost" onClick={props.onBack}>
            Back
          </Button>
        ) : null}
        <span class="meta grow" style={{ textAlign: "right" }}>
          {fmtWhen(r.created_at, host.timeZone)}
        </span>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {note ? <div class="notice">{note}</div> : null}
      {open ? (
        <section class="stack" aria-label="Why Butler did this">
          <hr class="sep" />
          {r.reasons.length > 1 ? (
            <div>
              <h3>Reasons</h3>
              <ul class="meta" style={{ margin: "4px 0 0", paddingLeft: "1.2em" }}>
                {r.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {r.context_used.length > 0 ? (
            <div>
              <h3>What I used</h3>
              <p class="meta">{r.context_used.join(" · ")}</p>
            </div>
          ) : null}
          {r.alternatives.length > 0 ? (
            <div>
              <h3>Other options I considered</h3>
              <ul class="meta" style={{ margin: "4px 0 0", paddingLeft: "1.2em" }}>
                {r.alternatives.map((a) => (
                  <li key={a.option}>
                    <strong>{a.option}</strong>: {a.rejected_because}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {r.authority.rule_texts.length > 0 ? (
            <div>
              <h3>{r.authority.decision === "DENY" ? "Rule that stopped it" : "Rule that applied"}</h3>
              <p class="meta">{r.authority.rule_texts.join(" ")}</p>
            </div>
          ) : null}
        </section>
      ) : null}
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
      {undo && original ? <p class="meta">Undid: {original.title}</p> : null}
      <Say text={data.spoken_summary} />
    </div>
  );
}
