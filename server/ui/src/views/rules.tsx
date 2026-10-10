/** ui://butler/rules: active rules grouped Ask first / Never / Allowed. A row opens Remove / Change. */
import { useState } from "preact/hooks";
import { Chevron } from "../icons";
import type { Rule, ViewProps } from "../types";
import { Button, Chip, ErrorBox, Skeleton } from "../ui";
import { originLine } from "./rule";

const GROUPS: Array<{ key: "allowed" | "ask_first" | "never"; title: string; effect: Rule["effect"] }> = [
  { key: "ask_first", title: "Ask first", effect: "ask_first" },
  { key: "never", title: "Never", effect: "never" },
  { key: "allowed", title: "Allowed", effect: "allow" },
];

export function RulesView({ data, error, host }: ViewProps) {
  const [open, setOpen] = useState<string | undefined>();
  const [removing, setRemoving] = useState<string | undefined>();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton lines={4} />;

  const lists: Record<string, Rule[]> = {
    allowed: (data["allowed"] as Rule[] | undefined) ?? [],
    ask_first: (data["ask_first"] as Rule[] | undefined) ?? [],
    never: (data["never"] as Rule[] | undefined) ?? [],
  };
  const total = Object.values(lists).reduce((n, l) => n + l.filter((r) => !gone.has(r.rule_id)).length, 0);

  const removeOrConfirm = async (rule: Rule) => {
    setBusy(rule.rule_id);
    setProblem(undefined);
    const confirming = removing === rule.rule_id;
    const res = await host.call("change_rule", { rule_id: rule.rule_id, change: "remove it", ...(confirming ? { confirm: true } : {}) });
    setBusy(undefined);
    if (!res.ok) return setProblem(res.message);
    setNote(res.spoken);
    if (confirming) {
      setGone(new Set([...gone, rule.rule_id]));
      setRemoving(undefined);
      setOpen(undefined);
    } else {
      setRemoving(rule.rule_id);
    }
  };

  return (
    <div class="view">
      <article class="card" aria-label="Your rules">
        <header>
          <h1>Your rules</h1>
          <span class="sub">{total} enforced by the gateway</span>
        </header>
        {problem ? <ErrorBox message={problem} /> : null}
        {note ? <div class="notice good" role="status">{note}</div> : null}
        {total === 0 ? <div class="notice">{data.spoken_summary}</div> : null}
        {GROUPS.map((g) => {
          const rules = lists[g.key]?.filter((r) => !gone.has(r.rule_id)) ?? [];
          if (rules.length === 0) return null;
          return (
            <section key={g.key} class="stack rule-group" aria-label={g.title}>
              <div class="row tight">
                <Chip kind={g.effect}>{g.title}</Chip>
                <span class="meta num">{rules.length}</span>
              </div>
              <ul class="plain needs">
                {rules.map((r) => (
                  <li key={r.rule_id} class={open === r.rule_id ? "need-open" : ""}>
                    <button type="button" class="need tap" aria-expanded={open === r.rule_id} onClick={() => setOpen(open === r.rule_id ? undefined : r.rule_id)}>
                      <span class="grow stack">
                        <span class="need-label">{r.text}</span>
                        <span class="meta">{originLine(r, host.timeZone)}</span>
                      </span>
                      <Chevron size={16} open={open === r.rule_id} />
                    </button>
                    {open === r.rule_id ? (
                      <div class="row tight wrap need-actions">
                        <Button variant="danger" busy={busy === r.rule_id} onClick={() => removeOrConfirm(r)}>
                          {removing === r.rule_id ? "Confirm removal" : "Remove"}
                        </Button>
                        <Button onClick={() => host.ask(`I want to change this rule: ${r.text.replace(/\.$/, "")}`)}>Change it…</Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </article>
    </div>
  );
}
