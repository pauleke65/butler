/** ui://butler/actions: ranked receipts as a carousel; "See more" goes fullscreen with a filterable ledger. */
import { useEffect, useState } from "preact/hooks";
import { fmtMoney, fmtWhen, TOOL_LABEL } from "../format";
import { Alert, Expand } from "../icons";
import type { Data, Receipt, ViewProps } from "../types";
import { authorityOf, AuthorityLine, Button, ErrorBox, Money, SimulatedBadge, Skeleton } from "../ui";
import { ReceiptCard } from "./receipt";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "purchases", label: "Purchases" },
  { id: "might_disagree", label: "Might disagree" },
  { id: "blocked", label: "Held or blocked" },
] as const;

const HEADING: Record<string, string> = {
  might_disagree: "You might disagree with",
  blocked: "Held or blocked",
  purchases: "Purchases and bookings",
};

function ActionCard({ r, onOpen, tz }: { r: Receipt; onOpen: () => void; tz?: string | undefined }) {
  const flagged = r.might_disagree.score >= 0.3 && r.might_disagree.top_reason;
  return (
    <button type="button" class={`card action tap${flagged ? " tabbed" : ""}`} onClick={onOpen} aria-label={`${r.title}. Tap for details`}>
      {flagged ? <span class="tab warn">Worth a look</span> : null}
      <span class="stack">
        <span class="t2">{r.title}</span>
        <span class="meta">{[TOOL_LABEL[r.action.tool] ?? "Action", fmtWhen(r.created_at, tz), r.simulated ? "Simulated" : ""].filter(Boolean).join(" · ")}</span>
      </span>
      <Money m={r.cost} />
      {flagged ? (
        <span class="flag body2">
          <Alert size={14} />
          <span>{r.might_disagree.top_reason}</span>
        </span>
      ) : (
        <span class="meta grow">{r.reasons[0] ?? ""}</span>
      )}
      <AuthorityLine receipt={r} />
    </button>
  );
}

function LedgerRow({ r, onOpen, tz }: { r: Receipt; onOpen: () => void; tz?: string | undefined }) {
  const a = authorityOf(r);
  return (
    <button type="button" class="ledger-row tap" onClick={onOpen} aria-label={`${r.title}. Tap for details`}>
      <span class={`chip ${a.kind}`}>{a.label}</span>
      <span class="grow stack">
        <span class="need-label">{r.title}</span>
        <span class="meta">{r.reasons[0] ?? ""}</span>
      </span>
      {r.simulated ? <SimulatedBadge /> : <span />}
      <span class="price small">{fmtMoney(r.cost)}</span>
      <span class="meta when">{fmtWhen(r.created_at, tz)}</span>
    </button>
  );
}

function Ledger(props: { initialFilter: string; host: ViewProps["host"]; onOpen: (r: Receipt) => void }) {
  const { host } = props;
  const [filter, setFilter] = useState(props.initialFilter);
  const [rows, setRows] = useState<Receipt[] | undefined>();
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = async (f: string, next?: string) => {
    setBusy(true);
    setError(undefined);
    const res = await host.call<Data & { actions?: Receipt[]; next_cursor?: string }>("get_ledger_page", { filter: f, limit: 10, ...(next ? { cursor: next } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setRows((prev) => (next ? [...(prev ?? []), ...(res.data.actions ?? [])] : (res.data.actions ?? [])));
    setCursor(res.data.next_cursor);
  };

  useEffect(() => {
    void load(props.initialFilter);
  }, []);

  return (
    <section class="view" aria-label="Ledger">
      <div class="ledger-head stack" style={{ gap: "var(--s-12)" }}>
        <h1>Everything Butler did</h1>
        <div class="filters" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <Button key={f.id} pressed={filter === f.id} onClick={() => { setFilter(f.id); setRows(undefined); void load(f.id); }}>
              {f.label}
            </Button>
          ))}
        </div>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {rows === undefined ? <Skeleton lines={4} /> : null}
      {rows?.length === 0 ? <div class="notice">Nothing matches this filter yet.</div> : null}
      {rows?.length ? (
        <div class="card ledger">
          {rows.map((r) => <LedgerRow key={r.action_id} r={r} onOpen={() => props.onOpen(r)} tz={host.timeZone} />)}
        </div>
      ) : null}
      {cursor ? <div><Button busy={busy} onClick={() => load(filter, cursor)}>Load more</Button></div> : null}
    </section>
  );
}

export function ActionsView({ data, error, host }: ViewProps) {
  const [detail, setDetail] = useState<Receipt | undefined>();
  const [ledger, setLedger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  if (error) return <div class="view"><ErrorBox message={error} /></div>;
  if (!data) return <Skeleton lines={2} />;

  const actions = (data["actions"] as Receipt[] | undefined) ?? [];
  const total = (data["total_count"] as number | undefined) ?? actions.length;
  const filter = (data["filter"] as string | undefined) ?? "all";

  const open = async (r: Receipt) => {
    setProblem(undefined);
    const res = await host.call<Data & { receipt?: Receipt }>("explain_action", { action_id: r.action_id });
    setDetail(res.ok && res.data.receipt ? res.data.receipt : r); // fall back to the receipt we already have
  };
  const seeMore = async () => {
    setBusy(true);
    await host.requestFullscreen();
    setBusy(false);
    setLedger(true);
  };

  if (detail) {
    return (
      <div class="view">
        <ReceiptCard receipt={detail} host={host} startOpen onBack={() => setDetail(undefined)} />
      </div>
    );
  }
  if (ledger || host.displayMode === "fullscreen") {
    return <Ledger initialFilter={filter} host={host} onOpen={open} />;
  }

  return (
    <div class="view">
      <header class="row spread on-canvas">
        <h1>{HEADING[filter] ?? "What Butler did"}</h1>
        <Button variant="quiet" icon={<Expand size={13} />} busy={busy} onClick={seeMore} label={`See more: all ${total}`}>
          See more
        </Button>
      </header>
      {problem ? <ErrorBox message={problem} /> : null}
      {actions.length === 0 ? (
        <div class="notice">{data.spoken_summary}</div>
      ) : (
        <div class={`carousel${actions.some((r) => r.might_disagree.score >= 0.3 && r.might_disagree.top_reason) ? " tabs" : ""}`} role="list">
          {actions.map((r, i) => (
            <div role="listitem" key={r.action_id} class="rise" style={{ animationDelay: `${i * 60}ms` }}>
              <ActionCard r={r} onOpen={() => void open(r)} tz={host.timeZone} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
