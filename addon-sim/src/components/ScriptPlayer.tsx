"use client";

import { useEffect, useRef, useState } from "react";
import { formatReport, runScript, type RunReport, type StepResult } from "@/lib/runner/runner";
import { ScriptError, parseScript, type Step } from "@/lib/runner/script";
import type { Simulator } from "@/lib/state/use-simulator";

const SAMPLE = `name: Quick check
steps:
  - say: "What are my rules?"
    expect_tool: list_rules
`;

/** UI "play script" mode: runs a YAML script through the same pipeline as live conversation (views render, voice speaks). */
export function ScriptPlayer({ sim, onClose }: { sim: Simulator; onClose(): void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [yamlText, setYamlText] = useState(SAMPLE);
  const [results, setResults] = useState<StepResult[]>([]);
  const [running, setRunning] = useState<number>();
  const [report, setReport] = useState<RunReport>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(undefined);

  useEffect(() => {
    void fetch("/api/scripts").then((r) => r.json()).then((b: { scripts: string[] }) => setFiles(b.scripts));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !running && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const load = async (name: string) => {
    const b = (await (await fetch(`/api/scripts?name=${encodeURIComponent(name)}`)).json()) as { yaml: string };
    setYamlText(b.yaml);
    setResults([]);
    setReport(undefined);
  };

  const play = async () => {
    setError(undefined);
    setResults([]);
    setReport(undefined);
    let script;
    try {
      script = parseScript(yamlText);
    } catch (e) {
      setError(e instanceof ScriptError ? e.message : String(e));
      return;
    }
    abort.current = new AbortController();
    const rep = await runScript(script, sim.driver, {
      signal: abort.current.signal,
      onStepStart: (i) => setRunning(i),
      onStep: (r) => setResults((cur) => [...cur, r]),
    });
    setRunning(undefined);
    setReport(rep);
  };

  const stepsTotal = (() => {
    try {
      return parseScript(yamlText).steps as Step[];
    } catch {
      return [];
    }
  })();

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Play script" onClick={() => !running && onClose()} data-no-ptt>
      <div className="flex max-h-[90vh] w-[980px] max-w-full flex-col rounded-2xl border border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">Play script</h2>
          <select aria-label="Load a script" className="h-8 rounded-md border border-line bg-bg px-2 text-sm" defaultValue="" onChange={(e) => e.target.value && void load(e.target.value)}>
            <option value="">load from scripts/…</option>
            {files.map((f) => <option key={f}>{f}</option>)}
          </select>
          <div className="ml-auto flex gap-2">
            {running === undefined ? (
              <button type="button" onClick={() => void play()} data-testid="play-script" className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-semibold text-slate-950">▶ Play</button>
            ) : (
              <button type="button" onClick={() => abort.current?.abort()} className="rounded-lg bg-red-500 px-4 py-1.5 text-sm font-semibold text-white">■ Stop</button>
            )}
            <button type="button" onClick={onClose} disabled={running !== undefined} aria-label="Close" className="rounded-md px-2 text-slate-300 hover:bg-white/10 disabled:opacity-40">✕</button>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden p-4">
          <textarea value={yamlText} onChange={(e) => setYamlText(e.target.value)} spellCheck={false} aria-label="Script YAML" className="min-h-[300px] resize-none rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-slate-200" />
          <div className="min-h-0 overflow-y-auto rounded-lg border border-line bg-bg p-3 scroll-thin" data-testid="script-results">
            {error && <div className="mb-2 rounded bg-red-500/15 p-2 text-xs text-red-200">{error}</div>}
            <ol className="space-y-1.5 text-sm">
              {stepsTotal.map((st, i) => {
                const r = results[i];
                const active = running === i;
                return (
                  <li key={i} className="flex gap-2">
                    <span className={`mt-0.5 w-12 shrink-0 text-[11px] font-bold ${r ? (r.status === "pass" ? "text-emerald-300" : "text-red-300") : active ? "text-amber-300" : "text-slate-600"}`}>{r ? r.status.toUpperCase() : active ? "RUN…" : "—"}</span>
                    <span>
                      <span className="text-slate-200">{st.name ?? st.say ?? (st.wait_until ? `wait_until ${st.wait_until.tool}` : st.call ? `call ${st.call.tool}` : st.device ? `device ${st.device}` : "step")}</span>
                      {r && <span className="ml-2 text-[11px] text-slate-500">{r.ms} ms</span>}
                      {r?.status === "fail" && <div className="text-[11px] text-red-300">{r.details.join(" | ")}</div>}
                    </span>
                  </li>
                );
              })}
            </ol>
            {report && (
              <pre className="mt-3 overflow-x-auto rounded bg-black/30 p-2 text-[10px] text-slate-400">{formatReport(report)}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
