"use client";

import { useState } from "react";
import type { ElicitationRequestInfo, ElicitationResponse, JsonSchema } from "@/lib/mcp/types";

type Value = string | number | boolean | string[];

function FormFields({ schema, values, setValues }: { schema?: JsonSchema; values: Record<string, Value>; setValues(v: Record<string, Value>): void }) {
  const props = Object.entries((schema?.properties ?? {}) as Record<string, JsonSchema>);
  return (
    <div className="space-y-4">
      {props.map(([k, p]) => {
        const title = (p.title as string | undefined) ?? k;
        const choices = Array.isArray(p.enum) ? (p.enum as string[]) : p.type === "boolean" ? ["true", "false"] : undefined;
        const cur = values[k];
        return (
          <fieldset key={k}>
            <legend className="mb-2 text-sm text-slate-300">{title}</legend>
            {choices ? (
              <div className="flex flex-wrap gap-2">
                {choices.map((c) => {
                  const v: Value = p.type === "boolean" ? c === "true" : c;
                  const selected = cur === v;
                  return (
                    <button key={c} type="button" data-testid="elicit-choice" onClick={() => setValues({ ...values, [k]: v })} className={`rounded-lg border px-4 py-2 text-sm ${selected ? "border-sky-400 bg-sky-400/20 text-white" : "border-line hover:bg-white/5"}`}>
                      {p.type === "boolean" ? (c === "true" ? "Yes" : "No") : c}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input className="h-10 w-full rounded-md border border-line bg-bg px-3 text-sm" type={p.type === "number" || p.type === "integer" ? "number" : "text"} value={String(cur ?? "")} onChange={(e) => setValues({ ...values, [k]: p.type === "number" || p.type === "integer" ? Number(e.target.value) : e.target.value })} />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

export function ElicitationModal({ req, onAnswer }: { req: ElicitationRequestInfo; onAnswer(id: string, r: ElicitationResponse): void }) {
  const defaults: Record<string, Value> = {};
  for (const [k, p] of Object.entries((req.requestedSchema?.properties ?? {}) as Record<string, JsonSchema>)) if (p.default !== undefined) defaults[k] = p.default as Value;
  const [values, setValues] = useState<Record<string, Value>>(defaults);
  const required = req.requestedSchema?.required ?? [];
  const ready = required.every((k) => values[k] !== undefined && values[k] !== "");
  let host = "";
  if (req.mode === "url" && req.url) {
    try {
      host = new URL(req.url).host;
    } catch {
      host = req.url;
    }
  }
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Request from add-on" data-testid="elicitation-modal" data-no-ptt>
      <div className="w-[520px] max-w-full rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="mb-1 text-[11px] uppercase tracking-widest text-slate-400">{req.server} asks · {req.mode === "url" ? "opens a web page" : "needs your answer"}</div>
        <p className="mb-4 text-lg font-medium text-slate-100">{req.message}</p>
        {req.mode === "form" ? (
          <>
            <FormFields schema={req.requestedSchema} values={values} setValues={setValues} />
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => onAnswer(req.id, { action: "decline" })} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-white/5">Decline</button>
              <button type="button" data-testid="elicit-submit" disabled={!ready} onClick={() => onAnswer(req.id, { action: "accept", content: values })} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40">Submit</button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
              This add-on wants to send you to <strong>{host}</strong>. Only continue if you trust this site. The simulator will not see anything you enter there.
              <div className="mt-2 break-all font-mono text-[11px] text-amber-200/80">{req.url}</div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => onAnswer(req.id, { action: "decline" })} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-white/5">Cancel</button>
              <button type="button" data-testid="elicit-open" onClick={() => { if (req.url) window.open(req.url, "_blank", "noopener,noreferrer"); onAnswer(req.id, { action: "accept" }); }} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950">Continue to {host}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
