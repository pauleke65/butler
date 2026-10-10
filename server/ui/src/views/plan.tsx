/** ui://butler/plan: the plan as a list. needs_you is pinned on top; Answer opens the decision, a done row opens its receipt. */
import { useState } from "preact/hooks";
import { planWhen } from "../format";
import { ArrowLeft, Bag, Calendar, Cloud, Dot, Mail, Sparkle } from "../icons";
import type { Data, Decision, Need, Plan, Receipt, ViewProps } from "../types";
import { Button, ErrorBox, NeedChip, SimulatedBadge, Skeleton } from "../ui";
import { DecisionPanel, ResultPanel, type DecisionResult } from "./options";
import { ReceiptCard } from "./receipt";

const SIMULATED_CAPS = new Set(["supplies", "services"]);

function sortNeeds(needs: Need[]): Need[] {
  const rank: Record<Need["status"], number> = { needs_you: 0, blocked: 1, doing: 2, done: 3, skipped: 4 };
  return [...needs].sort((a, b) => rank[a.status] - rank[b.status]);
}

const LEAD: Record<string, (p: { size?: number }) => preact.JSX.Element> = {
  messages: Mail,
  calendar: Calendar,
  supplies: Bag,
  services: Sparkle,
  context: Cloud,
};

function Lead({ n }: { n: Need }) {
  const Icon = LEAD[n.capability] ?? Dot;
  return (
    <span class="lead" aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}

function NeedText({ n }: { n: Need }) {
  return (
    <span class="grow stack">
      <span class="need-label">{n.label}</span>
      {n.note || SIMULATED_CAPS.has(n.capability) ? (
        <span class="row tight wrap">
          {n.note ? <span class="meta">{n.note}</span> : null}
          {SIMULATED_CAPS.has(n.capability) ? <SimulatedBadge /> : null}
        </span>
      ) : null}
    </span>
  );
}

export function PlanView({ data, error, host }: ViewProps) {
  const [decision, setDecision] = useState<Decision | undefined>();
  const [result, setResult] = useState<DecisionResult | undefined>();
  const [detail, setDetail] = useState<Receipt | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton lines={4} />;
  const plan = data["plan"] as Plan | undefined;
  if (!plan) return <div class="view"><div class="notice">{data.spoken_summary}</div></div>;

  const needs = sortNeeds(plan.needs);
  const done = plan.needs.filter((n) => n.status === "done").length;
  const doing = plan.needs.filter((n) => n.status === "doing").length;
  // only finished steps count as done; work in flight is said separately
  const progress =
    done === plan.needs.length
      ? `All ${done} done`
      : [done ? `${done} of ${plan.needs.length} done` : "", doing ? `${doing} under way` : ""].filter(Boolean).join(" · ");
  const when = planWhen(plan.starts_at, plan.ends_at, host.timeZone);
  // titles like "Dinner for 6, Friday 7 PM" already say when
  const titleSaysWhen = when !== "" && plan.title.toLowerCase().includes(when.slice(0, 3).toLowerCase());

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
        <div><Button variant="quiet" icon={<ArrowLeft size={13} />} onClick={() => { setResult(undefined); setDecision(undefined); }}>Back to the plan</Button></div>
      </div>
    );
  }
  if (decision) {
    return (
      <div class="view">
        <DecisionPanel decision={decision} host={host} onResult={setResult} />
        <div><Button variant="quiet" icon={<ArrowLeft size={13} />} onClick={() => setDecision(undefined)}>Back</Button></div>
      </div>
    );
  }

  return (
    <div class="view">
      <article class="card" aria-label={plan.title}>
        <header>
          <div class="stack">
            <h1 class="display">{plan.title}</h1>
            <p class="sub">{[titleSaysWhen ? "" : when, progress].filter(Boolean).join(" · ")}</p>
          </div>
        </header>
        {problem ? <ErrorBox message={problem} /> : null}
        <ul class="plain needs" aria-label="What Butler is handling">
          {needs.map((n) =>
            n.status === "needs_you" ? (
              <li key={n.need_id} class="need pinned">
                <Lead n={n} />
                <NeedText n={n} />
                <Button variant="cta" busy={busy === n.need_id} onClick={() => answer(n)}>
                  Answer
                </Button>
              </li>
            ) : n.action_ids.length > 0 ? (
              <li key={n.need_id}>
                <button type="button" class={`need tap need-${n.status}`} aria-busy={busy === n.need_id ? "true" : undefined} aria-label={`${n.label}: details`} onClick={() => details(n)}>
                  <Lead n={n} />
                  <NeedText n={n} />
                  <NeedChip status={n.status} />
                </button>
              </li>
            ) : (
              <li key={n.need_id} class={`need need-${n.status}`}>
                <Lead n={n} />
                <NeedText n={n} />
                <NeedChip status={n.status} />
              </li>
            ),
          )}
        </ul>
      </article>
    </div>
  );
}
