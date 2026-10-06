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

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return !!el.closest("input, textarea, select, [contenteditable='true'], [data-no-ptt]");
}

export function Simulator() {
  const sim = useSimulator();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
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

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold tracking-wide">addon-sim</h1>
          <span className="hidden text-[11px] text-slate-500 md:inline">MCP add-on simulator</span>
        </div>
        <div className="mx-3 flex rounded-lg border border-line p-0.5" role="group" aria-label="Device">
          {DEVICE_ORDER.map((d) => (
            <button key={d} type="button" data-testid={`device-${d}`} aria-pressed={sim.device === d} onClick={() => sim.setDevice(d)} className={`rounded-md px-2.5 py-1 text-xs ${sim.device === d ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}>
              {DEVICES[d].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span data-testid="llm-mode" className={`rounded-md px-2 py-0.5 ${sim.config.llmMode === "bedrock" ? "bg-violet-400/20 text-violet-200" : "bg-white/5 text-slate-300"}`} title="LLM_MODE">brain: {sim.config.llmMode}</span>
          <span className="rounded-md bg-white/5 px-2 py-0.5 text-slate-300" title="Speech output engine">voice: {sim.settings.voice.engine === "off" ? "off" : sim.voiceEngine === "none" ? "browser" : sim.voiceEngine}</span>
          {sim.connections.map((c) => (
            <span key={c.id} data-testid="conn-chip" title={c.error ?? `${c.url} (protocol ${c.protocolVersion})`} className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-0.5 text-slate-300">
              <span className={`h-1.5 w-1.5 rounded-full ${c.status === "connected" ? "bg-emerald-400" : c.status === "connecting" ? "bg-amber-300" : "bg-red-400"}`} />
              {c.name}
              {c.protocolVersion && <span className="font-mono text-slate-500">{c.protocolVersion}</span>}
            </span>
          ))}
          {sim.connecting && <span className="text-slate-500">connecting…</span>}
          {!sim.connecting && sim.connections.some((c) => c.status !== "connected") && (
            <button type="button" onClick={() => void sim.applyServers(sim.settings!.servers)} className="rounded-md border border-red-400/40 px-2 py-0.5 text-red-300 hover:bg-red-500/10">retry connection</button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setScriptsOpen(true)} className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-white/5">▶ Scripts</button>
          <button type="button" onClick={() => void sim.reset()} className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-white/5">New session</button>
          <button type="button" onClick={() => setSettingsOpen(true)} data-testid="open-settings" className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-white/5">Settings</button>
        </div>
      </header>

      {sim.error && (
        <div role="alert" className="flex items-center gap-3 bg-red-500/15 px-4 py-1.5 text-xs text-red-200">
          <span className="truncate">{sim.error}</span>
          <button type="button" onClick={sim.clearError} className="ml-auto underline">dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col bg-[radial-gradient(80%_60%_at_50%_0%,#0d1730,transparent)]">
          <DeviceStage sim={sim} />
        </main>
        <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-surface">
          <PanelHost sim={sim} />
          <Inspector sim={sim} />
        </aside>
      </div>

      <Transcript sim={sim} />

      {settingsOpen && <SettingsDrawer sim={sim} onClose={() => setSettingsOpen(false)} />}
      {scriptsOpen && <ScriptPlayer sim={sim} onClose={() => setScriptsOpen(false)} />}
      {sim.elicitation && <ElicitationModal key={sim.elicitation.id} req={sim.elicitation} onAnswer={(id, r) => void sim.answerElicitation(id, r)} />}
    </div>
  );
}
