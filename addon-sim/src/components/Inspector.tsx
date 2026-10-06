"use client";

import { useState } from "react";
import { FIRST_RENDER_BUDGET_MS, type Simulator } from "@/lib/state/use-simulator";
import type { InspectorCall } from "@/lib/state/types";
import type { ConnectionInfo } from "@/lib/mcp/types";
import { JsonView } from "./JsonView";

const ms = (n?: number | null) => (n === undefined || n === null ? "-" : `${n} ms`);

function Chip({ children, tone = "slate", title, testid }: { children: React.ReactNode; tone?: "slate" | "ok" | "warn" | "bad" | "accent"; title?: string; testid?: string }) {
  const cls = { slate: "bg-white/5 text-slate-300", ok: "bg-emerald-400/15 text-emerald-300", warn: "bg-amber-400/15 text-amber-300", bad: "bg-red-400/20 text-red-300", accent: "bg-sky-400/15 text-sky-300" }[tone];
  return (
    <span title={title} data-testid={testid} className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

function CallRow({ call }: { call: InspectorCall }) {
  const [open, setOpen] = useState(false);
  const rec = call.record;
  const isError = call.status === "error" || !!rec?.error || !!rec?.result?.isError;
  const r = call.render;
  return (
    <li data-testid="inspector-call" data-tool={call.tool} data-status={isError ? "error" : call.status} className={`rounded-lg border ${isError ? "border-red-400/50 bg-red-500/10" : "border-line bg-surface2/60"}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <span className={`h-2 w-2 shrink-0 rounded-full ${call.status === "running" ? "animate-pulse bg-amber-300" : isError ? "bg-red-400" : "bg-emerald-400"}`} />
        <span className="truncate font-mono text-[12px] text-slate-100">{call.tool}</span>
        <Chip tone={call.origin === "view" ? "accent" : "slate"}>{call.origin}</Chip>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {rec && <Chip title="time to first byte / total">{ms(rec.timings.ttfbMs)} · {ms(rec.timings.totalMs)}</Chip>}
        </span>
      </button>
      {(r || call.utterance) && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2">
          {call.utterance && <span className="truncate text-[11px] italic text-slate-400">&ldquo;{call.utterance}&rdquo;</span>}
          {r?.kind === "view" && (
            <>
              <Chip tone={r.slow ? "bad" : "ok"} title="tool result delivered to the view until its first paint" testid="render-time">
                render {r.firstRenderMs === undefined ? "…" : `${r.firstRenderMs} ms`}
              </Chip>
              {r.slow && (
                <Chip tone="warn" testid="slow-badge" title={`The first item of a carousel should render within ${FIRST_RENDER_BUDGET_MS} ms`}>
                  ⚠ carousel &gt; {FIRST_RENDER_BUDGET_MS} ms
                </Chip>
              )}
              {r.carousel && !r.slow && <Chip>carousel</Chip>}
              {r.initMs !== undefined && <Chip title="iframe created until view initialized">init {r.initMs} ms</Chip>}
              {r.resourceMs !== undefined && <Chip title="ui:// resource fetch">{r.resourceCached ? "resource cached" : `resource ${r.resourceMs} ms`}</Chip>}
              <Chip tone="accent">{r.uri}</Chip>
            </>
          )}
          {r?.kind === "hydrated" && <Chip tone="accent" title={r.note}>hydrated card</Chip>}
          {r?.kind === "suppressed" && <Chip tone="warn" title={r.note}>no view (voice-only)</Chip>}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          {rec?.error && <div className="rounded bg-red-500/15 p-2 font-mono text-[11px] text-red-200">{rec.error}</div>}
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">arguments · {call.server}</div>
            <JsonView value={call.args} />
          </div>
          {rec?.result && (
            <div>
              <div className={`mb-1 text-[10px] uppercase tracking-wider ${rec.result.isError ? "text-red-300" : "text-slate-500"}`}>result{rec.result.isError ? " (isError)" : ""}</div>
              <JsonView value={rec.result} defaultOpen={2} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ServerCard({ c }: { c: ConnectionInfo }) {
  const [open, setOpen] = useState(false);
  const dot = c.status === "connected" ? "bg-emerald-400" : c.status === "connecting" ? "bg-amber-300 animate-pulse" : "bg-red-400";
  return (
    <li className={`rounded-lg border ${c.status === "error" ? "border-red-400/50 bg-red-500/10" : "border-line bg-surface2/60"} p-3 text-[12px]`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-medium text-slate-100">{c.name}</span>
        <span className="truncate font-mono text-[11px] text-slate-500">{c.url}</span>
      </div>
      {c.error && <div className="mt-2 rounded bg-red-500/15 p-2 font-mono text-[11px] text-red-200">{c.error}</div>}
      {c.status === "connected" && (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-slate-500">protocol</dt>
            <dd data-testid="protocol-version" className="font-mono text-sky-300">{c.protocolVersion ?? "?"} <span className="text-slate-500">(negotiated)</span></dd>
            <dt className="text-slate-500">server</dt>
            <dd className="font-mono">{c.serverInfo?.name} {c.serverInfo?.version}</dd>
            <dt className="text-slate-500">connect</dt>
            <dd>{ms(c.connectMs)}</dd>
            <dt className="text-slate-500">tools</dt>
            <dd>{c.tools.length} ({c.tools.filter((t) => t.uiResourceUri).length} with UI, {c.tools.filter((t) => t.visibility && !t.visibility.includes("model")).length} app-only)</dd>
          </dl>
          <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-[11px] text-sky-300 hover:underline">{open ? "hide details" : "capabilities, tools, resources"}</button>
          {open && (
            <div className="mt-2 space-y-2">
              <div><div className="text-[10px] uppercase text-slate-500">declared by the simulator</div><JsonView value={c.clientCapabilities} /></div>
              <div><div className="text-[10px] uppercase text-slate-500">server capabilities</div><JsonView value={c.serverCapabilities} /></div>
              {c.instructions && <div className="text-[11px] text-slate-400">instructions: {c.instructions}</div>}
              <ul className="space-y-1">
                {c.tools.map((t) => (
                  <li key={t.name} className="rounded bg-black/20 p-1.5">
                    <span className="font-mono text-[11px] text-slate-100">{t.name}</span>{" "}
                    {t.uiResourceUri && <Chip tone="accent">{t.uiResourceUri}</Chip>}{" "}
                    {t.visibility && !t.visibility.includes("model") && <Chip tone="warn" title="hidden from the model">app only</Chip>}
                    <div className="text-[10px] text-slate-500">{t.description.slice(0, 140)}</div>
                  </li>
                ))}
              </ul>
              {c.resources.length > 0 && <div className="text-[11px] text-slate-400">resources: {c.resources.map((r) => r.uri).join(", ")}</div>}
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function Inspector({ sim }: { sim: Simulator }) {
  const [tab, setTab] = useState<"calls" | "servers">("calls");
  const calls = [...sim.calls].reverse();
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(sim.exportSession(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `addon-sim-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Inspector">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2" role="tablist">
        {(["calls", "servers"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === t ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}>
            {t === "calls" ? `Calls (${sim.calls.length})` : `Servers (${sim.connections.length})`}
          </button>
        ))}
        <button type="button" onClick={exportJson} className="ml-auto rounded-md border border-line px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5">
          Export session JSON
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scroll-thin">
        {tab === "calls" ? (
          calls.length ? (
            <ul className="space-y-2">{calls.map((c) => <CallRow key={c.id} call={c} />)}</ul>
          ) : (
            <p className="text-sm text-slate-500">No tool calls yet. Say or type something.</p>
          )
        ) : (
          <ul className="space-y-2">{sim.connections.map((c) => <ServerCard key={c.id} c={c} />)}</ul>
        )}
      </div>
    </section>
  );
}
