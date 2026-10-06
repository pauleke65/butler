/** ui://butler/actions: ranked receipts as a carousel; "See more" goes fullscreen with a filterable ledger. */
import { useEffect, useState } from "preact/hooks";
import { fmtMoney, fmtWhen, TOOL_LABEL } from "../format";
import type { Data, Receipt, ViewProps } from "../types";
import { authorityOf, AuthorityBadge, Button, Chip, ErrorBox, Say, SimulatedBadge, Skeleton } from "../ui";
import { ReceiptCard } from "./receipt";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "purchases", label: "Purchases" },
  { id: "might_disagree", label: "Might disagree" },
  { id: "blocked", label: "Held or blocked" },
] as const;

function ActionCard({ r, onOpen, tz }: { r: Receipt; onOpen: () => void; tz?: string | undefined }) {
  return (
    <button type="button" class="card" style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", width: "100%" }} onClick={onOpen} aria-label={`${r.title}. Tap for details`}>
      <div class="row spread wrap">
        <span class="meta">{TOOL_LABEL[r.action.tool] ?? "Action"} · {fmtWhen(r.created_at, tz)}</span>
        {r.simulated ? <SimulatedBadge /> : null}
      </div>
      <h2>{r.title}</h2>
      {r.cost ? <div class="price">{fmtMoney(r.cost)}</div> : null}
      <p class="grow dim">{r.reasons[0] ?? ""}</p>
      <AuthorityBadge receipt={r} />
      {r.might_disagree.score >= 0.3 && r.might_disagree.top_reason ? <Chip kind="needs_you">{r.might_disagree.top_reason}</Chip> : null}
    </button>
  );
}

function LedgerRow({ r, onOpen, tz }: { r: Receipt; onOpen: () => void; tz?: string | undefined }) {
  const a = authorityOf(r);
  return (
    <button type="button" class="card" style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", width: "100%", flexDirection: "row", alignItems: "center", padding: "var(--space-2) var(--space-3)" }} onClick={onOpen} aria-label={`${r.title}. Tap for details`}>
      <span class={`badge ${a.kind}`} style={{ minWidth: "7.5em", justifyContent: "center" }}>{a.label}</span>
      <span class="grow stack" style={{ gap: 2 }}>
        <strong>{r.title}</strong>
        <span class="meta">{r.reasons[0] ?? ""}</span>
      </span>
      {r.simulated ? <SimulatedBadge /> : null}
      <span class="price" style={{ minWidth: "4em", textAlign: "right" }}>{fmtMoney(r.cost)}</span>
      <span class="meta" style={{ minWidth: "7em", textAlign: "right" }}>{fmtWhen(r.created_at, tz)}</span>
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
    <section class="stack" style={{ gap: "var(--space-2)" }} aria-label="Ledger">
      <div class="ledger-head stack" style={{ gap: "var(--space-2)" }}>
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
      {rows?.length === 0 ? <div class="notice">Nothing here yet.</div> : null}
      <div class="list">{rows?.map((r) => <LedgerRow key={r.action_id} r={r} onOpen={() => props.onOpen(r)} tz={host.timeZone} />)}</div>
      {cursor ? <Button busy={busy} onClick={() => load(filter, cursor)}>Load more</Button> : null}
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
    return (
      <div class="view">
        <Ledger initialFilter={filter} host={host} onOpen={open} />
      </div>
    );
  }

  return (
    <div class="view">
      <header class="row spread wrap">
        <h1>{filter === "might_disagree" ? "You might disagree with" : filter === "blocked" ? "Held or blocked" : filter === "purchases" ? "Purchases and bookings" : "What Butler did"}</h1>
        <span class="meta">{total} in total</span>
      </header>
      {problem ? <ErrorBox message={problem} /> : null}
      {actions.length === 0 ? (
        <div class="notice">{data.spoken_summary}</div>
      ) : (
        <div class="carousel" role="list">
          {actions.map((r) => (
            <div role="listitem" key={r.action_id} style={{ display: "flex" }}>
              <ActionCard r={r} onOpen={() => void open(r)} tz={host.timeZone} />
            </div>
          ))}
        </div>
      )}
      <div class="row spread wrap">
        <Say text={data.spoken_summary} />
        <Button busy={busy} onClick={seeMore}>See more</Button>
      </div>
    </div>
  );
}
