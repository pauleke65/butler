"use client";

import { useState } from "react";

function Scalar({ v }: { v: unknown }) {
  if (typeof v === "string") return <span className="json-str">{JSON.stringify(v)}</span>;
  if (typeof v === "number") return <span className="json-num">{v}</span>;
  if (typeof v === "boolean" || v === null) return <span className="json-bool">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function Node({ k, v, depth, defaultOpen }: { k?: string; v: unknown; depth: number; defaultOpen: number }) {
  const [open, setOpen] = useState(depth < defaultOpen);
  const isObj = v !== null && typeof v === "object";
  const label = k !== undefined ? <><span className="json-key">{JSON.stringify(k)}</span>: </> : null;
  if (!isObj) return <div className="pl-4">{label}<Scalar v={v} /></div>;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const [l, r] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <div className="pl-4">{label}{l}{r}</div>;
  return (
    <div className="pl-4">
      <button type="button" onClick={() => setOpen(!open)} className="text-left hover:text-white" aria-expanded={open}>
        <span className="mr-1 inline-block w-3 text-slate-500">{open ? "▾" : "▸"}</span>
        {label}
        {l}
        {!open && <span className="text-slate-500"> {entries.length} {Array.isArray(v) ? "items" : "keys"} </span>}
        {!open && r}
      </button>
      {open && (
        <>
          {entries.map(([ek, ev]) => (
            <Node key={ek} k={Array.isArray(v) ? undefined : ek} v={ev} depth={depth + 1} defaultOpen={defaultOpen} />
          ))}
          <div className="pl-0">{r}</div>
        </>
      )}
    </div>
  );
}

/** Collapsible JSON tree (first `defaultOpen` levels expanded). */
export function JsonView({ value, defaultOpen = 2 }: { value: unknown; defaultOpen?: number }) {
  return (
    <div className="-ml-4 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-300 scroll-thin">
      <Node v={value} depth={0} defaultOpen={defaultOpen} />
    </div>
  );
}
