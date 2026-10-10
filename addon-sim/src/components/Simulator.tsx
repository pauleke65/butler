"use client";

import { useEffect, useState } from "react";
import { DEVICES, DEVICE_ORDER } from "@/lib/devices";
import { useSimulator } from "@/lib/state/use-simulator";
import { DeviceStage } from "./DeviceStage";
import { ElicitationModal } from "./ElicitationModal";
import { Inspector } from "./Inspector";
import { PanelHost } from "./PanelHost";
import { ScriptPlayer } from "./ScriptPlayer";
import { SettingsDrawer } from "./SettingsDrawer";
import { Transcript } from "./Transcript";
import { GearIcon, ListIcon, PlayIcon, RefreshIcon } from "./icons";

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return !!el.closest("input, textarea, select, [contenteditable='true'], [data-no-ptt]");
}

export function Simulator() {
  const sim = useSimulator();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [callsOpen, setCallsOpen] = useState(false);
  const { startListening, stopListening, sttOk } = sim;

  // Hold the space bar to talk (push-to-talk).
  useEffect(() => {
    if (!sttOk) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      startListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      e.preventDefault();
      stopListening();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sttOk, startListening, stopListening]);

  if (!sim.settings || !sim.config) {
    return <div className="grid h-full place-items-center text-slate-500">Starting simulator…</div>;
  }

  const chip = "flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-[12px] text-slate-300";
  const action = "flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] text-slate-200 transition-colors hover:bg-surface2";
  return (
    <div className="flex min-h-screen flex-col bg-bg lg:h-screen">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 lg:h-14 lg:flex-nowrap lg:py-0">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-fg">addon-sim</h1>
          <span className="hidden text-[12px] text-slate-500 lg:inline">MCP add-on simulator</span>
        </div>
        <div className="flex rounded-full bg-surface p-1" role="group" aria-label="Device">
          {DEVICE_ORDER.map((d) => (
            <button key={d} type="button" data-testid={`device-${d}`} aria-pressed={sim.device === d} onClick={() => sim.setDevice(d)} className={`rounded-full px-3.5 py-1 text-[13px] transition-colors ${sim.device === d ? "bg-surface3 text-fg" : "text-slate-400 hover:text-slate-200"}`}>
              {DEVICES[d].label}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <span data-testid="llm-mode" className={chip} title="LLM_MODE">brain: {sim.config.llmMode}</span>
          <span className={chip} title="Speech output engine">voice: {sim.settings.voice.engine === "off" ? "off" : sim.voiceEngine === "none" ? "browser" : sim.voiceEngine}</span>
          {sim.connections.map((c) => (
            <span key={c.id} data-testid="conn-chip" title={c.error ?? `${c.url} (protocol ${c.protocolVersion})`} className={chip}>
              <span className={`h-1.5 w-1.5 rounded-full ${c.status === "connected" ? "bg-ok" : c.status === "connecting" ? "bg-warn" : "bg-bad"}`} />
              {c.name}
              {c.protocolVersion && <span className="font-mono text-[11px] text-slate-500">{c.protocolVersion}</span>}
            </span>
          ))}
          {sim.connecting && <span className="text-[12px] text-slate-500">connecting…</span>}
          {!sim.connecting && sim.connections.some((c) => c.status !== "connected") && (
            <button type="button" onClick={() => void sim.applyServers(sim.settings!.servers)} className="rounded-full bg-[#3d1b27] px-3 py-1 text-[12px] text-bad hover:bg-[#4d2231]">Retry connection</button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setCallsOpen(!callsOpen)} aria-pressed={callsOpen} data-testid="open-inspector" className={`${action} ${callsOpen ? "bg-surface2" : ""}`}><ListIcon size={14} />Tool calls{sim.calls.length ? <span className="tnum text-slate-500">{sim.calls.length}</span> : null}</button>
          <button type="button" onClick={() => setScriptsOpen(true)} className={action}><PlayIcon size={14} />Scripts</button>
          <button type="button" onClick={() => void sim.reset()} className={action}><RefreshIcon size={14} />New session</button>
          <button type="button" onClick={() => setSettingsOpen(true)} data-testid="open-settings" className={action}><GearIcon size={15} />Settings</button>
        </div>
      </header>

      {sim.error && (
        <div role="alert" className="mx-4 mb-2 flex items-center gap-3 rounded-full bg-[#3d1b27] px-4 py-1.5 text-[13px] text-red-200">
          <span className="truncate">{sim.error}</span>
          <button type="button" onClick={sim.clearError} className="ml-auto underline underline-offset-2">Dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 lg:flex-row">
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            <DeviceStage sim={sim} />
            <PanelHost sim={sim} />
          </div>
          <Transcript sim={sim} />
        </main>
      </div>

      {callsOpen && (
        // tool calls are a debugging aid: a slide-over on demand, not a column that takes room from the device
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Tool calls" onClick={() => setCallsOpen(false)} data-no-ptt>
          <aside className="m-3 flex w-[400px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-[20px] bg-surface shadow-[0_24px_60px_-16px_rgba(0,0,0,0.8)]" onClick={(e) => e.stopPropagation()}>
            <Inspector sim={sim} onClose={() => setCallsOpen(false)} />
          </aside>
        </div>
      )}
      {settingsOpen && <SettingsDrawer sim={sim} onClose={() => setSettingsOpen(false)} />}
      {scriptsOpen && <ScriptPlayer sim={sim} onClose={() => setScriptsOpen(false)} />}
      {sim.elicitation && <ElicitationModal key={sim.elicitation.id} req={sim.elicitation} onAnswer={(id, r) => void sim.answerElicitation(id, r)} />}
    </div>
  );
}
