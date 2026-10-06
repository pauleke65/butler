"use client";

import { useEffect, useRef, useState } from "react";
import type { Simulator } from "@/lib/state/use-simulator";

export function Transcript({ sim }: { sim: Simulator }) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [sim.transcript.length, sim.interim]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void sim.runTurn(t);
  };
  const busy = sim.status === "thinking";
  return (
    <section className="flex h-[212px] shrink-0 border-t border-line bg-surface" aria-label="Transcript">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 scroll-thin" role="log" aria-live="polite" data-testid="transcript">
          {sim.transcript.length === 0 && <p className="py-2 text-sm text-slate-500">Hold <kbd className="rounded bg-white/10 px-1">Space</kbd> to talk, or type below. Replies are captioned here.</p>}
          {sim.transcript.map((e) => (
            <div key={e.id} data-role={e.role} className="flex gap-2 py-0.5 text-sm">
              <span className={`w-14 shrink-0 text-right text-[11px] uppercase tracking-wide ${e.role === "user" ? "text-sky-300" : e.role === "assistant" ? "text-emerald-300" : "text-slate-500"}`}>{e.role === "user" ? "You" : e.role === "assistant" ? "Assistant" : "System"}</span>
              <span className={e.role === "system" ? "text-slate-500" : "text-slate-100"}>
                {e.text}
                {e.tools && e.tools.length > 0 && <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{e.tools.join(", ")}</span>}
              </span>
            </div>
          ))}
          {sim.interim && (
            <div className="flex gap-2 py-0.5 text-sm text-sky-200/70">
              <span className="w-14 shrink-0 text-right text-[11px] uppercase text-sky-300">You</span>
              <span className="italic">{sim.interim}…</span>
            </div>
          )}
          {busy && <div className="py-0.5 pl-16 text-sm text-slate-500">thinking…</div>}
          <div ref={endRef} />
        </div>
        <form onSubmit={submit} className="flex items-center gap-2 border-t border-line p-2">
          <button
            type="button"
            data-testid="ptt"
            data-no-ptt
            aria-label="Push to talk (hold) - or hold the space bar"
            title={sim.sttOk ? "Hold to talk (or hold Space)" : "Speech recognition is not available in this browser; use the text box"}
            disabled={!sim.sttOk}
            onPointerDown={(e) => {
              e.preventDefault();
              sim.startListening();
            }}
            onPointerUp={() => sim.stopListening()}
            onPointerLeave={() => sim.status === "listening" && sim.stopListening()}
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border text-lg ${sim.status === "listening" ? "border-sky-300 bg-sky-400/30 text-white" : "border-line bg-surface2 text-slate-300"} disabled:opacity-40`}
          >
            <span aria-hidden>🎙</span>
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="utterance-input"
            aria-label="Type what you would say"
            placeholder={sim.sttOk ? "…or type what you would say" : "Type what you would say (no speech recognition in this browser)"}
            className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <button type="submit" disabled={!text.trim() || busy} className="h-10 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-40">Send</button>
          {sim.status === "speaking" && (
            <button type="button" onClick={sim.stopSpeaking} className="h-10 rounded-lg border border-line px-3 text-sm text-slate-200 hover:bg-white/5">Stop</button>
          )}
        </form>
      </div>
    </section>
  );
}
