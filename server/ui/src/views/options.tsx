/** ui://butler/options: a carousel of choices for one pending decision. Choose -> answer_decision. */
import { useState } from "preact/hooks";
import { fmtMoney } from "../format";
import type { Data, Decision, DecisionOption, HostApi, Receipt, ViewProps } from "../types";
import { Button, Chip, ErrorBox, Say, SimulatedBadge, Skeleton } from "../ui";
import { ReceiptCard } from "./receipt";

export interface DecisionResult {
  decision?: Decision;
  receipt?: Receipt;
  spoken: string;
}

export function OptionCard(props: { option: DecisionOption; suggested: boolean; busy: boolean; disabled: boolean; onChoose: () => void }) {
  const { option: o } = props;
  return (
    <article class={`card ${props.suggested ? "selected" : ""}`} aria-label={o.title}>
      <h2>{o.title}</h2>
      {o.subtitle ? <p class="dim">{o.subtitle}</p> : null}
      <div class="row spread">
        {o.price ? <div class="price">{fmtMoney(o.price)}</div> : <span />}
        {o.simulated ? <SimulatedBadge /> : null}
      </div>
      <p class="grow">{o.tradeoff}</p>
      {props.suggested ? <Chip kind="active">Suggested</Chip> : null}
      <Button variant="primary" block busy={props.busy} disabled={props.disabled} onClick={props.onChoose}>
        Choose
      </Button>
    </article>
  );
}

/** The decision itself: option carousel (choose_option) or approve/skip card (approve_action). */
export function DecisionPanel(props: { decision: Decision; host: HostApi; onResult: (r: DecisionResult) => void }) {
  const { decision: d, host } = props;
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const answer = async (key: string, choice: string) => {
    setBusy(key);
    setError(undefined);
    const res = await host.call<Data & { decision?: Decision; receipt?: Receipt }>("answer_decision", { decision_id: d.decision_id, choice });
    setBusy(undefined);
    if (!res.ok) return setError(res.message);
    props.onResult({
      ...(res.data.decision ? { decision: res.data.decision } : {}),
      ...(res.data.receipt ? { receipt: res.data.receipt } : {}),
      spoken: res.spoken,
    });
  };

  if (d.kind === "approve_action") {
    const o = d.options[0];
    return (
      <article class="card pinned" aria-label="Approval needed">
        <div class="row wrap">
          <h1 class="grow">{d.question}</h1>
          {o?.simulated ? <SimulatedBadge /> : null}
        </div>
        {o ? (
          <div class="row spread wrap">
            <p class="dim grow">{o.action_draft?.summary ?? o.title}</p>
            {o.price ? <div class="price">{fmtMoney(o.price)}</div> : null}
          </div>
        ) : null}
        {d.reason_held ? (
          <p class="meta">
            <span class="badge held">Held</span> by your rule: {d.reason_held.rule_text}
          </p>
        ) : null}
        {error ? <ErrorBox message={error} /> : null}
        <div class="row wrap">
          <Button variant="primary" busy={busy === "approve"} disabled={busy !== undefined} onClick={() => answer("approve", "approve")}>
            Approve
          </Button>
          <Button busy={busy === "reject"} disabled={busy !== undefined} onClick={() => answer("reject", "reject")}>
            Skip it
          </Button>
        </div>
      </article>
    );
  }

  return (
    <section class="stack" style={{ gap: "var(--space-2)" }} aria-label="Options">
      <h1>{d.question}</h1>
      {error ? <ErrorBox message={error} /> : null}
      <div class="carousel" role="list">
        {d.options.map((o) => (
          <div role="listitem" key={o.option_id} style={{ display: "flex" }}>
            <OptionCard
              option={o}
              suggested={o.option_id === d.default_option_id}
              busy={busy === o.option_id}
              disabled={busy !== undefined}
              onChoose={() => answer(o.option_id, o.option_id)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResultPanel({ result, host }: { result: DecisionResult; host: HostApi }) {
  return (
    <section class="stack" style={{ gap: "var(--space-2)" }}>
      {result.receipt ? <ReceiptCard receipt={result.receipt} host={host} /> : <div class="notice">{result.spoken}</div>}
      <Say text={result.spoken} />
    </section>
  );
}

/** Pull the decision out of whichever tool result is shown (get_status or answer_decision). */
export function decisionOf(data: Data): Decision | undefined {
  const pending = data["pending_decisions"] as Decision[] | undefined;
  const single = data["decision"] as Decision | undefined;
  return pending?.[0] ?? single;
}

export function OptionsView({ data, error, host }: ViewProps) {
  const [result, setResult] = useState<DecisionResult | undefined>();
  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton lines={2} />;
  const decision = decisionOf(data);
  if (!decision) return <div class="view"><div class="notice">{data.spoken_summary || "Nothing is waiting on you."}</div></div>;
  return (
    <div class="view">
      {result ? <ResultPanel result={result} host={host} /> : <DecisionPanel decision={decision} host={host} onResult={setResult} />}
      {result ? null : <Say text={data.spoken_summary} />}
    </div>
  );
}
