"use client";

import { useEffect, useRef, useState } from "react";
import type { Simulator } from "@/lib/state/use-simulator";
import { MicIcon, SendIcon, StopIcon } from "./icons";

const ROLE = {
  user: { label: "You", cls: "text-slate-400" },
  assistant: { label: "Assistant", cls: "text-sky-300" },
  system: { label: "System", cls: "text-slate-600" },
} as const;

export function Transcript({ sim }: { sim: Simulator }) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scroll the log itself; scrollIntoView would also scroll the page when the shell is stacked on a narrow screen
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sim.transcript.length, sim.interim]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void sim.runTurn(t);
  };
  const busy = sim.status === "thinking";
  const listening = sim.status === "listening";
  return (
    <section className="flex h-[188px] shrink-0 flex-col rounded-[20px] bg-surface" aria-label="Transcript">
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 scroll-thin" role="log" aria-live="polite" data-testid="transcript">
        {sim.transcript.length === 0 && (
          <p className="py-1 text-[14px] text-slate-500">
            Hold <kbd className="rounded-md bg-surface2 px-1.5 py-0.5 text-[12px] text-slate-300">Space</kbd> to talk, or type below. Replies are captioned here.
          </p>
        )}
        {sim.transcript.map((e) => (
          <div key={e.id} data-role={e.role} className="flex items-baseline gap-3 py-[3px] text-[14px] leading-snug">
            <span className={`w-[68px] shrink-0 text-[12px] font-medium ${ROLE[e.role].cls}`}>{ROLE[e.role].label}</span>
            <span className={e.role === "system" ? "text-slate-500" : e.role === "user" ? "text-slate-300" : "text-slate-100"}>
              {e.text}
              {e.tools && e.tools.length > 0 && <span className="ml-2 rounded-full bg-surface2 px-2 py-0.5 font-mono text-[11px] text-slate-400">{e.tools.join(", ")}</span>}
            </span>
          </div>
        ))}
        {sim.interim && (
          <div className="flex items-baseline gap-3 py-[3px] text-[14px]">
            <span className="w-[68px] shrink-0 text-[12px] font-medium text-slate-400">You</span>
            <span className="text-sky-200">{sim.interim}…</span>
          </div>
        )}
        {busy && <div className="py-[3px] pl-[80px] text-[14px] text-slate-500">Thinking…</div>}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2 p-3">
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
          onPointerLeave={() => listening && sim.stopListening()}
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors ${listening ? "bg-accent text-on-accent" : "bg-surface2 text-slate-300 hover:bg-surface3"} disabled:opacity-40`}
        >
          <MicIcon size={18} />
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="utterance-input"
          aria-label="Type what you would say"
          placeholder={sim.sttOk ? "…or type what you would say" : "Type what you would say (no speech recognition in this browser)"}
          className="h-11 min-w-0 flex-1 rounded-full bg-bg px-5 text-[15px] text-slate-100 outline-offset-0 placeholder:text-slate-500 focus:bg-[#0c1a2e]"
        />
        <button type="submit" disabled={!text.trim() || busy} className="flex h-11 items-center gap-2 rounded-full bg-accent pl-4 pr-5 text-[15px] font-semibold text-on-accent transition-colors hover:bg-white disabled:opacity-40">
          <SendIcon size={16} />
          Send
        </button>
        {sim.status === "speaking" && (
          <button type="button" onClick={sim.stopSpeaking} className="flex h-11 items-center gap-2 rounded-full bg-surface2 px-4 text-[14px] text-slate-200 hover:bg-surface3">
            <StopIcon size={14} />
            Stop
          </button>
        )}
      </form>
    </section>
  );
}
