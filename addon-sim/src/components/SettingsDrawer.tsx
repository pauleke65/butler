"use client";

import { useEffect, useState } from "react";
import { DEVICES, DEVICE_ORDER } from "@/lib/devices";
import type { ServerConfig } from "@/lib/mcp/types";
import type { Settings } from "@/lib/state/settings";
import type { Simulator } from "@/lib/state/use-simulator";
import { CloseIcon } from "./icons";

const input = "h-9 w-full rounded-md border border-line bg-bg px-2 text-sm text-slate-100 placeholder:text-slate-500";
const label = "mb-1 block text-[11px] uppercase tracking-wider text-slate-400";

function blank(n: number): ServerConfig {
  return { id: `server${n}`, name: `Server ${n}`, url: "http://localhost:8000/mcp", auth: { type: "none" }, enabled: true };
}

export function SettingsDrawer({ sim, onClose }: { sim: Simulator; onClose(): void }) {
  const s = sim.settings!;
  const [servers, setServers] = useState<ServerConfig[]>(s.servers);
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices().map((v) => v.name) ?? []);
    load();
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (i: number, p: Partial<ServerConfig>) => setServers((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const llm = sim.config?.llmMode ?? "offline";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="flex h-full w-[480px] max-w-full flex-col bg-surface shadow-[0_0_60px_-10px_rgba(0,0,0,0.8)]" onClick={(e) => e.stopPropagation()} data-no-ptt>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="grid h-8 w-8 place-items-center rounded-full text-slate-300 hover:bg-surface2"><CloseIcon size={16} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 scroll-thin">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">MCP servers</h3>
            <div className="space-y-3">
              {servers.map((srv, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-line bg-surface2/60 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={label}>Id</label><input className={input} value={srv.id} onChange={(e) => patch(i, { id: e.target.value.replace(/\W+/g, "-") })} /></div>
                    <div><label className={label}>Name</label><input className={input} value={srv.name} onChange={(e) => patch(i, { name: e.target.value })} /></div>
                  </div>
                  <div><label className={label}>URL (Streamable HTTP)</label><input className={input} value={srv.url} onChange={(e) => patch(i, { url: e.target.value })} placeholder="http://localhost:8000/mcp" /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={label}>Auth</label>
                      <select
                        className={input}
                        value={srv.auth.type}
                        onChange={(e) =>
                          patch(i, {
                            auth:
                              e.target.value === "bearer"
                                ? { type: "bearer", token: "" }
                                : e.target.value === "client_credentials"
                                  ? { type: "client_credentials", tokenUrl: "", clientId: "", clientSecret: "" }
                                  : { type: "none" },
                          })
                        }
                      >
                        <option value="none">none</option>
                        <option value="bearer">bearer token</option>
                        <option value="client_credentials">client credentials (Cognito)</option>
                      </select>
                    </div>
                    <div><label className={label}>Invocation name</label><input className={input} value={srv.invocationName ?? ""} onChange={(e) => patch(i, { invocationName: e.target.value })} placeholder="e.g. Butler" /></div>
                  </div>
                  {srv.auth.type === "bearer" && (
                    <div><label className={label}>Bearer token</label><input className={input} type="password" value={srv.auth.token} onChange={(e) => patch(i, { auth: { type: "bearer", token: e.target.value } })} autoComplete="off" /></div>
                  )}
                  {srv.auth.type === "client_credentials" && (
                    <div className="space-y-2">
                      <div><label className={label}>Token URL</label><input className={input} value={srv.auth.tokenUrl} onChange={(e) => patch(i, { auth: { ...(srv.auth as Extract<ServerConfig["auth"], { type: "client_credentials" }>), tokenUrl: e.target.value } })} placeholder="https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token" /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className={label}>Client id</label><input className={input} value={srv.auth.clientId} onChange={(e) => patch(i, { auth: { ...(srv.auth as Extract<ServerConfig["auth"], { type: "client_credentials" }>), clientId: e.target.value } })} /></div>
                        <div><label className={label}>Client secret</label><input className={input} type="password" autoComplete="off" value={srv.auth.clientSecret} onChange={(e) => patch(i, { auth: { ...(srv.auth as Extract<ServerConfig["auth"], { type: "client_credentials" }>), clientSecret: e.target.value } })} /></div>
                      </div>
                      <div><label className={label}>Scope (optional)</label><input className={input} value={srv.auth.scope ?? ""} onChange={(e) => patch(i, { auth: { ...(srv.auth as Extract<ServerConfig["auth"], { type: "client_credentials" }>), scope: e.target.value || undefined } })} placeholder="butler/invoke" /></div>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <label className="flex items-center gap-2"><input type="checkbox" checked={srv.enabled !== false} onChange={(e) => patch(i, { enabled: e.target.checked })} /> enabled</label>
                    <button type="button" className="text-red-300 hover:underline" onClick={() => setServers((cur) => cur.filter((_, j) => j !== i))}>remove</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setServers((c) => [...c, blank(c.length + 1)])} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-white/5">+ Add server</button>
              <button type="button" onClick={() => void sim.applyServers(servers)} disabled={sim.connecting} className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50">{sim.connecting ? "Connecting…" : "Save and reconnect"}</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Tokens are kept in this browser (localStorage) and sent to the simulator server only to connect.</p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Brain</h3>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={label}>LLM mode (server env)</label><div className={`${input} flex items-center`}>{llm}</div></div>
              <div><label className={label}>Model (bedrock mode)</label><input className={input} value={s.model} onChange={(e) => sim.updateSettings({ model: e.target.value })} /></div>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Set <code>LLM_MODE=offline|bedrock</code> and <code>BEDROCK_MODEL_BRAIN</code> when starting the server. The model field overrides the model per request in bedrock mode.</p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Voice</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label}>Speech output</label>
                <select className={input} value={s.voice.engine} onChange={(e) => sim.updateSettings({ voice: { ...s.voice, engine: e.target.value as Settings["voice"]["engine"] } })}>
                  <option value="auto">auto (Polly, else browser)</option>
                  <option value="browser">browser voice</option>
                  <option value="off">off (captions only)</option>
                </select>
              </div>
              <div><label className={label}>Polly voice id</label><input className={input} value={s.voice.pollyVoiceId} onChange={(e) => sim.updateSettings({ voice: { ...s.voice, pollyVoiceId: e.target.value } })} /></div>
              <div className="col-span-2">
                <label className={label}>Browser voice (fallback)</label>
                <select className={input} value={s.voice.browserVoiceName} onChange={(e) => sim.updateSettings({ voice: { ...s.voice, browserVoiceName: e.target.value } })}>
                  <option value="">default</option>
                  {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Polly is used only when the server runs with <code>LLM_MODE=bedrock</code> and AWS credentials; otherwise the browser voice speaks.</p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Device</h3>
            <div className="flex gap-2">
              {DEVICE_ORDER.map((d) => (
                <button key={d} type="button" onClick={() => sim.setDevice(d)} className={`rounded-md border px-3 py-1.5 text-sm ${s.device === d ? "border-sky-400 bg-sky-400/10 text-sky-200" : "border-line hover:bg-white/5"}`}>{DEVICES[d].label}</button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Panel plugins</h3>
            <label className={label}>Panel module URLs (one per line)</label>
            <textarea className="h-20 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs" value={s.panelUrls.join("\n")} onChange={(e) => sim.updateSettings({ panelUrls: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} placeholder="http://localhost:3002/panel.js" />
            <p className="mt-1 text-[11px] text-slate-500">Reload the page to load changed panel URLs.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
