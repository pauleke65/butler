/** ui://butler/options: a carousel of choices for one pending decision. Choose -> answer_decision. */
import { useState } from "preact/hooks";
import { Check, Shield } from "../icons";
import type { Data, Decision, DecisionOption, HostApi, Receipt, ViewProps } from "../types";
import { Button, ErrorBox, Money, SimulatedBadge, Skeleton, stripDot } from "../ui";
import { ReceiptCard } from "./receipt";

export interface DecisionResult {
  decision?: Decision;
  receipt?: Receipt;
  spoken: string;
}

export function OptionCard(props: { option: DecisionOption; suggested: boolean; busy: boolean; disabled: boolean; onChoose: () => void; labelSimulated?: boolean }) {
  const { option: o } = props;
  const sim = o.simulated && props.labelSimulated !== false;
  return (
    <article class={`card option${props.suggested ? " suggested tabbed" : ""}`} aria-label={props.suggested ? `${o.title}, suggested` : o.title}>
      {props.suggested ? <span class="tab good">Suggested</span> : null}
      <div class="stack">
        <h2>{o.title}</h2>
        {o.subtitle ? <p class="sub">{o.subtitle}</p> : null}
      </div>
      <Money m={o.price} />
      <p class="meta grow">{o.tradeoff}</p>
      {sim ? (
        <div class="row tight wrap">
          <SimulatedBadge />
        </div>
      ) : null}
      <Button variant="cta" block busy={props.busy} disabled={props.disabled} onClick={props.onChoose}>
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
      <article class="card tabbed" aria-label="Approval needed">
        <span class="tab warn">Needs your OK</span>
        <header>
          <h1>{d.question}</h1>
          <Money m={o?.price} />
        </header>
        {o ? (
          <div class="row tight wrap">
            <p class="dim body2">{o.action_draft?.summary ?? o.title}</p>
            {o.simulated ? <SimulatedBadge /> : null}
          </div>
        ) : null}
        {d.reason_held ? (
          <div class="tile warn row tight held-by">
            <Shield size={15} />
            <span class="body2">Held by your rule “{stripDot(d.reason_held.rule_text)}”</span>
          </div>
        ) : null}
        {error ? <ErrorBox message={error} /> : null}
        <div class="row end wrap">
          <Button busy={busy === "reject"} disabled={busy !== undefined} onClick={() => answer("reject", "reject")}>
            Skip it
          </Button>
          <Button variant="primary" icon={<Check size={14} />} busy={busy === "approve"} disabled={busy !== undefined} onClick={() => answer("approve", "approve")}>
            Approve
          </Button>
        </div>
      </article>
    );
  }

  // one label for the whole set when every provider is simulated
  const allSimulated = d.options.length > 0 && d.options.every((o) => o.simulated);
  return (
    <section class="view" aria-label="Options">
      <div class="row spread on-canvas">
        <h1>{d.question}</h1>
        {allSimulated ? <SimulatedBadge /> : null}
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div class={`carousel${d.default_option_id ? " tabs" : ""}`} role="list">
        {d.options.map((o, i) => (
          <div role="listitem" key={o.option_id} class="rise" style={{ animationDelay: `${i * 60}ms` }}>
            <OptionCard
              option={o}
              suggested={o.option_id === d.default_option_id}
              busy={busy === o.option_id}
              disabled={busy !== undefined}
              onChoose={() => answer(o.option_id, o.option_id)}
              labelSimulated={!allSimulated}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResultPanel({ result, host }: { result: DecisionResult; host: HostApi }) {
  return (
    <section class="view">
      {result.spoken ? (
        <div class="notice good row tight" role="status">
          <Check size={15} />
          <span>{result.spoken}</span>
        </div>
      ) : null}
      {result.receipt ? <ReceiptCard receipt={result.receipt} host={host} /> : null}
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
  return <div class="view">{result ? <ResultPanel result={result} host={host} /> : <DecisionPanel decision={decision} host={host} onResult={setResult} />}</div>;
}
