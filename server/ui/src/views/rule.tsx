/** ui://butler/rule: one rule, either a draft awaiting "yes" or an active rule. Confirm / Remove. */
import { useState } from "preact/hooks";
import { fmtDate } from "../format";
import type { Data, Rule, ViewProps } from "../types";
import { Button, Chip, ErrorBox, Say, Skeleton } from "../ui";

export const EFFECT_LABEL: Record<Rule["effect"], string> = { allow: "Allowed", ask_first: "Ask first", never: "Never" };

export function originLine(rule: Rule, tz?: string): string {
  if (rule.origin.type === "default") return "A default rule";
  return `From your correction on ${fmtDate(rule.origin.created_at, tz, { day: "numeric", month: "short" })}`;
}

export function statusOf(rule: Rule, needsConfirmation: boolean): { kind: string; label: string } {
  if (needsConfirmation && rule.policy_status === "draft") return { kind: "pending", label: "Draft: say yes to confirm" };
  if (!rule.active && rule.policy_status === "disabled") return { kind: "undone", label: "Removed" };
  if (rule.policy_status === "creating") return { kind: "creating", label: "Starting up" };
  if (rule.policy_status === "failed") return { kind: "blocked", label: "Couldn't start" };
  if (rule.active) return { kind: "active", label: "Active" };
  return { kind: "pending", label: "Draft" };
}

export function RuleView({ data, error, host }: ViewProps) {
  const [rule, setRule] = useState<Rule | undefined>();
  const [needsConfirm, setNeedsConfirm] = useState<boolean | undefined>();
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [undoOffer, setUndoOffer] = useState<{ action_id: string; summary: string } | undefined>(
    (data?.["offered_undo"] as { action_id: string; summary: string } | undefined) ?? undefined,
  );

  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton lines={2} />;
  const initial = data["rule"] as Rule | undefined;
  const current = rule ?? initial;
  if (!current) return <div class="view"><div class="notice">{data.spoken_summary}</div></div>;
  const confirmNeeded = needsConfirm ?? Boolean(data["needs_confirmation"]);
  const status = statusOf(current, confirmNeeded);

  const confirm = async () => {
    setBusy("confirm");
    setProblem(undefined);
    const utter = current.origin.type === "correction" ? current.origin.utterance : current.text;
    const res = removing
      ? await host.call<Data & { rule?: Rule }>("change_rule", { rule_id: current.rule_id, change: "remove it", confirm: true })
      : await host.call<Data & { rule?: Rule; offered_undo?: { action_id: string; summary: string } }>("object_to_action", { correction: utter, confirm: true });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    if (res.data.rule) setRule(res.data.rule);
    setNeedsConfirm(false);
    setRemoving(false);
    setNote(res.spoken);
    const offer = (res.data as { offered_undo?: { action_id: string; summary: string } }).offered_undo;
    if (offer) setUndoOffer(offer);
  };

  const remove = async () => {
    setBusy("remove");
    setProblem(undefined);
    const res = await host.call<Data & { rule?: Rule; needs_confirmation?: boolean }>("change_rule", { rule_id: current.rule_id, change: "remove it" });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    setRemoving(true);
    setNeedsConfirm(true);
    setNote(res.spoken);
  };

  const undo = async () => {
    if (!undoOffer) return;
    setBusy("undo");
    const res = await host.call("undo_action", { action_id: undoOffer.action_id });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    setUndoOffer(undefined);
    setNote(res.spoken);
  };

  const isDraft = confirmNeeded && !removing && current.policy_status === "draft";
  return (
    <div class="view">
      <article class="card" aria-label="Rule">
        <div class="row wrap">
          <Chip kind={current.effect}>{EFFECT_LABEL[current.effect]}</Chip>
          <Chip kind={status.kind}>{status.label}</Chip>
        </div>
        <h1>{current.text}</h1>
        <p class="meta">{originLine(current, host.timeZone)}</p>
        {problem ? <ErrorBox message={problem} /> : null}
        {note ? <div class="notice">{note}</div> : null}
        <div class="row wrap">
          {isDraft || removing ? (
            <Button variant="primary" busy={busy === "confirm"} onClick={confirm}>
              {removing ? "Confirm removal" : "Confirm"}
            </Button>
          ) : null}
          {current.active && !removing ? (
            <Button variant="danger" busy={busy === "remove"} onClick={remove}>
              Remove
            </Button>
          ) : null}
          {undoOffer ? (
            <Button busy={busy === "undo"} onClick={undo}>
              {undoOffer.summary}
            </Button>
          ) : null}
        </div>
      </article>
      <Say text={data.spoken_summary} />
    </div>
  );
}
