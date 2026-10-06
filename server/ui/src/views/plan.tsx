/** ui://butler/plan: the plan as a list. needs_you is pinned on top; Answer opens the decision, Details explains the action. */
import { useState } from "preact/hooks";
import { planWhen } from "../format";
import type { Data, Decision, Need, Plan, Receipt, ViewProps } from "../types";
import { Button, ErrorBox, NeedChip, Say, SimulatedBadge, Skeleton } from "../ui";
import { DecisionPanel, ResultPanel, type DecisionResult } from "./options";
import { ReceiptCard } from "./receipt";

const SIMULATED_CAPS = new Set(["supplies", "services"]);

function sortNeeds(needs: Need[]): Need[] {
  const rank: Record<Need["status"], number> = { needs_you: 0, blocked: 1, doing: 2, done: 3, skipped: 4 };
  return [...needs].sort((a, b) => rank[a.status] - rank[b.status]);
}

export function PlanView({ data, error, host }: ViewProps) {
  const [decision, setDecision] = useState<Decision | undefined>();
  const [result, setResult] = useState<DecisionResult | undefined>();
  const [detail, setDetail] = useState<Receipt | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton />;
  const plan = data["plan"] as Plan | undefined;
  if (!plan) return <div class="view"><div class="notice">{data.spoken_summary}</div></div>;

  const needs = sortNeeds(plan.needs);
  const handled = plan.needs.filter((n) => n.status === "done" || n.status === "doing").length;
  const when = planWhen(plan.starts_at, plan.ends_at, host.timeZone);

  const answer = async (need: Need) => {
    setBusy(need.need_id);
    setProblem(undefined);
    // the decision may already be in the tool result; otherwise ask get_status for it
    const embedded = (data["pending_decisions"] as Decision[] | undefined)?.find((d) => d.need_id === need.need_id);
    if (embedded) {
      setBusy(undefined);
      return setDecision(embedded);
    }
    const res = await host.call<Data & { pending_decisions?: Decision[] }>("get_status", { plan_id: plan.plan_id });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    const d = res.data.pending_decisions?.find((x) => x.need_id === need.need_id) ?? res.data.pending_decisions?.[0];
    if (d) setDecision(d);
    else setProblem("Nothing is waiting on you right now.");
  };

  const details = async (need: Need) => {
    const id = need.action_ids[need.action_ids.length - 1];
    if (!id) return;
    setBusy(need.need_id);
    setProblem(undefined);
    const res = await host.call<Data & { receipt?: Receipt }>("explain_action", { action_id: id });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    if (res.data.receipt) setDetail(res.data.receipt);
  };

  if (detail) {
    return (
      <div class="view">
        <ReceiptCard receipt={detail} host={host} startOpen onBack={() => setDetail(undefined)} />
      </div>
    );
  }
  if (result) {
    return (
      <div class="view">
        <ResultPanel result={result} host={host} />
        <Button onClick={() => { setResult(undefined); setDecision(undefined); }}>Back to the plan</Button>
      </div>
    );
  }
  if (decision) {
    return (
      <div class="view">
        <DecisionPanel decision={decision} host={host} onResult={setResult} />
        <div><Button variant="ghost" onClick={() => setDecision(undefined)}>Back</Button></div>
      </div>
    );
  }

  return (
    <div class="view">
      <header class="stack">
        <h1>{plan.title}</h1>
        <p class="dim">
          {[when, `${handled} of ${plan.needs.length} handled`].filter(Boolean).join(" · ")}
        </p>
      </header>
      {problem ? <ErrorBox message={problem} /> : null}
      <ul class="list" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="What Butler is handling">
        {needs.map((n) => (
          <li key={n.need_id} class={`card ${n.status === "needs_you" ? "pinned" : ""}`} style={{ padding: "var(--space-2) var(--space-3)" }}>
            <div class="row">
              <NeedChip status={n.status} />
              <div class="grow stack" style={{ gap: 2 }}>
                <h3>{n.label}</h3>
                {n.note ? <p class="meta">{n.note}</p> : null}
              </div>
              {SIMULATED_CAPS.has(n.capability) ? <SimulatedBadge /> : null}
              {n.status === "needs_you" ? (
                <Button variant="primary" busy={busy === n.need_id} onClick={() => answer(n)}>
                  Answer
                </Button>
              ) : n.action_ids.length > 0 ? (
                <Button variant="ghost" busy={busy === n.need_id} onClick={() => details(n)}>
                  Details
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <Say text={data.spoken_summary} />
    </div>
  );
}
