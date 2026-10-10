"use client";

import { useState } from "react";
import { FIRST_RENDER_BUDGET_MS, type Simulator } from "@/lib/state/use-simulator";
import type { InspectorCall } from "@/lib/state/types";
import type { ConnectionInfo } from "@/lib/mcp/types";
import { JsonView } from "./JsonView";
import { CloseIcon, DownloadIcon } from "./icons";

const ms = (n?: number | null) => (n === undefined || n === null ? "-" : `${n} ms`);

function Chip({ children, tone = "slate", title, testid }: { children: React.ReactNode; tone?: "slate" | "ok" | "warn" | "bad" | "accent"; title?: string; testid?: string }) {
  const cls = { slate: "bg-surface3/70 text-slate-300", ok: "bg-[#123a36] text-ok", warn: "bg-[#3a2f17] text-warn", bad: "bg-[#3d1b27] text-bad", accent: "bg-[#173a6b] text-sky-200" }[tone];
  return (
    <span title={title} data-testid={testid} className={`tnum rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
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
    <li data-testid="inspector-call" data-tool={call.tool} data-status={isError ? "error" : call.status} className={`rounded-2xl ${isError ? "bg-[#3d1b27]" : "bg-surface2"}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 pb-1.5 pt-2.5 text-left">
        <span className={`h-2 w-2 shrink-0 rounded-full ${call.status === "running" ? "animate-pulse bg-warn" : isError ? "bg-bad" : "bg-ok"}`} />
        <span className="truncate font-mono text-[12.5px] text-slate-100">{call.tool}</span>
        <Chip tone={call.origin === "view" ? "accent" : "slate"}>{call.origin}</Chip>
        {rec && (
          <span className="tnum ml-auto shrink-0 text-[11.5px] text-slate-500" title="time to first byte / total">
            {ms(rec.timings.ttfbMs)} · {ms(rec.timings.totalMs)}
          </span>
        )}
      </button>
      {(r || call.utterance) && (
        <div className="flex flex-col gap-0.5 px-3 pb-2.5 pl-7 text-[11.5px] text-slate-500">
          {call.utterance && <span className="truncate pb-0.5 text-[12px] text-slate-400">&ldquo;{call.utterance}&rdquo;</span>}
          {r?.kind === "view" && (
            <>
              <span className="tnum">
                <span data-testid="render-time" title="tool result delivered to the view until its first paint" className={r.slow ? "text-bad" : ""}>
                  render {r.firstRenderMs === undefined ? "…" : `${r.firstRenderMs} ms`}
                </span>
                {r.initMs !== undefined && <span title="iframe created until view initialized"> · init {r.initMs} ms</span>}
                {r.resourceMs !== undefined && <span title="ui:// resource fetch"> · {r.resourceCached ? "resource cached" : `resource ${r.resourceMs} ms`}</span>}
                {r.carousel && !r.slow && <span> · carousel</span>}
              </span>
              {r.slow && (
                <span className="self-start">
                  <Chip tone="warn" testid="slow-badge" title={`The first item of a carousel should render within ${FIRST_RENDER_BUDGET_MS} ms`}>
                    carousel over {FIRST_RENDER_BUDGET_MS} ms
                  </Chip>
                </span>
              )}
              <span className="truncate font-mono text-[11px] text-slate-500">{r.uri}</span>
            </>
          )}
          {r?.kind === "hydrated" && <span title={r.note}>hydrated card (no UI resource)</span>}
          {r?.kind === "suppressed" && <span title={r.note}>no view: voice-only device</span>}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line/70 px-3 py-2.5">
          {rec?.error && <div className="rounded-xl bg-[#3d1b27] p-2 font-mono text-[11px] text-red-200">{rec.error}</div>}
          <div>
            <div className="mb-1 text-[11px] font-medium text-slate-500">Arguments · {call.server}</div>
            <JsonView value={call.args} />
          </div>
          {rec?.result && (
            <div>
              <div className={`mb-1 text-[11px] font-medium ${rec.result.isError ? "text-bad" : "text-slate-500"}`}>Result{rec.result.isError ? " (isError)" : ""}</div>
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
  const dot = c.status === "connected" ? "bg-ok" : c.status === "connecting" ? "bg-warn animate-pulse" : "bg-bad";
  return (
    <li className={`rounded-2xl ${c.status === "error" ? "bg-[#3d1b27]" : "bg-surface2"} p-3.5 text-[12px]`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-medium text-slate-100">{c.name}</span>
        <span className="truncate font-mono text-[11px] text-slate-500">{c.url}</span>
      </div>
      {c.error && <div className="mt-2 rounded-xl bg-black/20 p-2 font-mono text-[11px] text-red-200">{c.error}</div>}
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

export function Inspector({ sim, onClose }: { sim: Simulator; onClose?: () => void }) {
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
      <div className="flex items-center gap-1 px-3 pb-2 pt-3" role="tablist">
        {(["calls", "servers"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`tnum rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${tab === t ? "bg-surface3 text-fg" : "text-slate-400 hover:text-slate-200"}`}>
            {t === "calls" ? `Calls (${sim.calls.length})` : `Servers (${sim.connections.length})`}
          </button>
        ))}
        <button type="button" onClick={exportJson} title="Export session JSON" className="ml-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-slate-300 transition-colors hover:bg-surface2">
          <DownloadIcon size={13} />
          Export JSON
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close tool calls" className="grid h-8 w-8 place-items-center rounded-full text-slate-300 hover:bg-surface2">
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1 scroll-thin">
        {tab === "calls" ? (
          calls.length ? (
            <ul className="space-y-2">{calls.map((c) => <CallRow key={c.id} call={c} />)}</ul>
          ) : (
            <p className="px-1 py-2 text-[13px] text-slate-500">No tool calls yet. Every call the assistant or a view makes shows up here, with timings and the raw result.</p>
          )
        ) : (
          <ul className="space-y-2">{sim.connections.map((c) => <ServerCard key={c.id} c={c} />)}</ul>
        )}
      </div>
    </section>
  );
}
