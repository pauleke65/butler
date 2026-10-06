"use client";

import type { ToolResult } from "@/lib/mcp/types";
import { spokenFromResult } from "@/lib/mcp/tools";

type Obj = Record<string, unknown>;

const TITLE_KEYS = ["title", "name", "label", "question", "text"];
const SKIP = new Set(["ok", "spoken_summary", "simulated"]);

function titleOf(o: Obj): string | undefined {
  for (const k of TITLE_KEYS) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Obj;
    if (typeof o.amount_minor === "number") return `$${(o.amount_minor / 100).toFixed(2)}`;
    return JSON.stringify(v);
  }
  return String(v);
}

function Fields({ o, skip }: { o: Obj; skip?: Set<string> }) {
  const hidden = skip ?? new Set<string>();
  const show = ([k, v]: [string, unknown]) => !hidden.has(k) && v !== undefined && v !== null && (typeof v !== "object" || "amount_minor" in (v as Obj));
  const entries = Object.entries(o).filter(show);
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8em] text-slate-300">
      {entries.slice(0, 8).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k.replace(/_/g, " ")}</dt>
          <dd className="truncate">{fmt(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Fallback for results without a UI resource (mimics a "hydrated" assistant card): headline from
 * spoken_summary / text, arrays of objects as cards, other objects as key/value lists.
 */
export function HydratedCard({ tool, result }: { tool: string; result?: ToolResult }) {
  const sc = (result?.structuredContent ?? {}) as Obj;
  const headline = spokenFromResult(result);
  const lists = Object.entries(sc).filter(([, v]) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object")) as Array<[string, Obj[]]>;
  const objects = Object.entries(sc).filter(([k, v]) => !SKIP.has(k) && v && typeof v === "object" && !Array.isArray(v)) as Array<[string, Obj]>;
  const scalars = Object.fromEntries(Object.entries(sc).filter(([k, v]) => !SKIP.has(k) && (typeof v !== "object" || v === null)));
  return (
    <div data-testid="hydrated-card" className="flex w-full flex-col gap-4 p-8 text-slate-100">
      <div className="text-[0.7em] uppercase tracking-widest text-slate-400">{tool.replace(/_/g, " ")}</div>
      <div className="text-[1.6em] font-semibold leading-tight">{headline}</div>
      {Object.keys(scalars).length > 0 && <Fields o={scalars} />}
      {objects.map(([k, o]) => (
        <section key={k} className="rounded-2xl bg-white/5 p-4">
          <div className="text-[0.7em] uppercase tracking-widest text-slate-400">{k.replace(/_/g, " ")}</div>
          <div className="text-[1.1em] font-medium">{titleOf(o) ?? ""}</div>
          <Fields o={o} skip={new Set(TITLE_KEYS)} />
        </section>
      ))}
      {lists.map(([k, items]) => (
        <section key={k}>
          <div className="mb-2 text-[0.7em] uppercase tracking-widest text-slate-400">{k.replace(/_/g, " ")}</div>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {items.slice(0, 8).map((it, i) => (
              <div key={i} className="min-w-[14em] flex-1 rounded-2xl bg-white/5 p-4">
                <div className="text-[1.05em] font-medium">{titleOf(it) ?? `#${i + 1}`}</div>
                <Fields o={it} skip={new Set(TITLE_KEYS)} />
              </div>
            ))}
          </div>
        </section>
      ))}
      {result?.isError && <div className="rounded-xl border border-red-400/40 bg-red-500/10 p-3 text-red-200">The add-on returned an error.</div>}
    </div>
  );
}
