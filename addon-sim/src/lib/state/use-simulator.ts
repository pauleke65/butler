"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicConfig } from "../config";
import { DEVICES, type DeviceId } from "../devices";
import type { HubEvent, TurnEvent } from "../events";
import type { CallRecord, ConnectionInfo, ElicitationRequestInfo, ElicitationResponse, ToolResult, UiResourcePayload } from "../mcp/types";
import type { PanelSimEvent } from "../panels/types";
import type { Driver, TurnOutcome } from "../runner/runner";
import { Speaker, type TtsEngine } from "../voice/tts";
import { PushToTalk, sttSupported } from "../voice/stt";
import { loadSettings, mergeSettings, saveSettings, type Settings } from "./settings";
import type { ActiveView, InspectorCall, RenderInfo, SessionExport, Status, TranscriptEntry } from "./types";
import type { ViewMetrics } from "../apps-host/view-host";

export const FIRST_RENDER_BUDGET_MS = 500;
const SESSION_ID = "browser-session";

let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** Heuristic: a carousel is a view whose URI says so, or (when the URI is not clearly a list/card) whose data holds a 3-5 item list of titled objects. */
export function looksLikeCarousel(uri: string | undefined, sc: unknown): boolean {
  if (uri && /(carousel|options|actions|gallery)/i.test(uri)) return true;
  if (uri && /(plan|list|rules?|status|receipt|card)/i.test(uri)) return false;
  const card = (x: unknown) => !!x && typeof x === "object" && ("title" in (x as object) || "name" in (x as object));
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 3 || !v || typeof v !== "object") return false;
    if (Array.isArray(v)) return (v.length >= 3 && v.length <= 5 && v.every(card)) || v.some((x) => walk(x, depth + 1));
    return Object.values(v as Record<string, unknown>).some((x) => walk(x, depth + 1));
  };
  return walk(sc, 0);
}

/** Browser-side cache of ui:// resources for this page session. */
const resourceCache = new Map<string, UiResourcePayload>();
export async function fetchUiResource(server: string, uri: string): Promise<UiResourcePayload> {
  const key = `${server}|${uri}`;
  const hit = resourceCache.get(key);
  if (hit) return { ...hit, cached: true, fetchMs: 0 };
  const t0 = performance.now();
  const res = await fetch(`/api/mcp/resource?server=${encodeURIComponent(server)}&uri=${encodeURIComponent(uri)}`);
  const body = (await res.json()) as UiResourcePayload & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `resource fetch failed (${res.status})`);
  const payload = { ...body, cached: false, fetchMs: Math.round(performance.now() - t0) };
  resourceCache.set(key, payload);
  return payload;
}
export function clearResourceCache(): void {
  resourceCache.clear();
}

interface Deferred {
  promise: Promise<ToolResult>;
  resolve(r: ToolResult): void;
  reject(e: Error): void;
}
function deferred(): Deferred {
  let resolve!: (r: ToolResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ToolResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // avoid unhandled rejection noise; consumers handle it
  return { promise, resolve, reject };
}

export function useSimulator() {
  const [config, setConfig] = useState<PublicConfig>();
  const [settings, setSettingsState] = useState<Settings>();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [calls, setCalls] = useState<InspectorCall[]>([]);
  const [view, setView] = useState<ActiveView>();
  const [displayMode, setDisplayModeState] = useState<"inline" | "fullscreen">("inline");
  const [status, setStatus] = useState<Status>("idle");
  const [interim, setInterim] = useState("");
  const [elicitation, setElicitation] = useState<ElicitationRequestInfo>();
  const [caption, setCaption] = useState("");
  const [voiceEngine, setVoiceEngine] = useState<TtsEngine>("none");
  const [error, setError] = useState<string>();
  const [sttOk, setSttOk] = useState(false);

  const settingsRef = useRef<Settings>(undefined);
  const configRef = useRef<PublicConfig>(undefined);
  const viewRef = useRef<ActiveView>(undefined);
  const deviceRef = useRef<DeviceId>("display-15");
  const pendingResults = useRef(new Map<string, Deferred>());
  const panelSubs = useRef(new Set<(e: PanelSimEvent) => void>());
  const speakerRef = useRef<Speaker>(undefined);
  const pttRef = useRef<PushToTalk>(undefined);
  const speakingRef = useRef(false);
  const listeningRef = useRef(false);
  const thinkingRef = useRef(false);
  const callsRef = useRef<InspectorCall[]>([]);
  const lastUtterance = useRef("");

  settingsRef.current = settings;
  configRef.current = config;
  viewRef.current = view;
  callsRef.current = calls;
  if (settings) deviceRef.current = settings.device;

  const emitPanel = useCallback((e: Omit<PanelSimEvent, "at">) => {
    const ev = { ...e, at: Date.now() } as PanelSimEvent;
    for (const cb of panelSubs.current) cb(ev);
  }, []);

  const recomputeStatus = useCallback(() => {
    setStatus(listeningRef.current ? "listening" : thinkingRef.current ? "thinking" : speakingRef.current ? "speaking" : "idle");
  }, []);

  const patchCall = useCallback((id: string, patch: Partial<InspectorCall> | ((c: InspectorCall) => Partial<InspectorCall>)) => {
    setCalls((prev) => prev.map((c) => (c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c)));
  }, []);

  const addTranscript = useCallback((e: Omit<TranscriptEntry, "id" | "at">) => {
    const entry: TranscriptEntry = { id: nid("t"), at: Date.now(), ...e };
    setTranscript((t) => [...t, entry]);
    return entry.id;
  }, []);

  // ---- bootstrap: server defaults + stored settings, then connect -----------------------------------
  const refreshConnections = useCallback(async () => {
    const res = await fetch("/api/servers");
    const body = (await res.json()) as { connections: ConnectionInfo[] };
    setConnections(body.connections);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = (await (await fetch("/api/config")).json()) as PublicConfig;
      if (cancelled) return;
      const defaults: Settings = {
        servers: cfg.servers,
        device: "display-15",
        model: cfg.model,
        voice: { engine: "auto", pollyVoiceId: cfg.voice.pollyVoiceId, browserVoiceName: "" },
        panelUrls: cfg.panelUrls,
      };
      const merged = mergeSettings(defaults, loadSettings());
      setConfig(cfg);
      setSettingsState(merged);
      setSttOk(sttSupported());
      setConnecting(true);
      try {
        const res = await fetch("/api/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ servers: merged.servers }) });
        const body = (await res.json()) as { connections: ConnectionInfo[] };
        if (!cancelled) setConnections(body.connections);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- speaker + push-to-talk -------------------------------------------------------------------------
  useEffect(() => {
    speakerRef.current = new Speaker({
      engine: () => (configRef.current?.voice.pollyEnabled ? settingsRef.current?.voice.engine ?? "auto" : settingsRef.current?.voice.engine === "off" ? "off" : "browser"),
      pollyVoiceId: () => settingsRef.current?.voice.pollyVoiceId ?? "Joanna",
      browserVoiceName: () => settingsRef.current?.voice.browserVoiceName ?? "",
      onState: ({ speaking, engine }) => {
        speakingRef.current = speaking;
        if (engine !== "none") setVoiceEngine(engine);
        recomputeStatus();
      },
    });
    return () => speakerRef.current?.stop();
  }, [recomputeStatus]);

  // ---- views ------------------------------------------------------------------------------------------
  const closeView = useCallback(() => {
    setView(undefined);
    setDisplayModeState("inline");
  }, []);

  const openView = useCallback((v: Omit<ActiveView, "id" | "openedAt"> & { openedAt?: number }) => {
    const next: ActiveView = { ...v, id: nid("view"), openedAt: v.openedAt ?? performance.now() };
    setDisplayModeState("inline");
    setView(next);
    return next;
  }, []);

  const setRender = useCallback((callId: string, render: RenderInfo) => patchCall(callId, (c) => ({ render: { ...c.render, ...render } })), [patchCall]);

  const onViewMetrics = useCallback(
    (viewState: ActiveView, m: ViewMetrics) => {
      patchCall(viewState.callId, (c) => ({
        render: {
          ...(c.render ?? { kind: "view" as const }),
          kind: "view",
          uri: viewState.uri,
          firstRenderMs: m.firstRenderMs ?? c.render?.firstRenderMs,
          initMs: m.initMs ?? c.render?.initMs,
          carousel: c.render?.carousel,
          slow: !!c.render?.carousel && (m.firstRenderMs ?? c.render?.firstRenderMs ?? 0) > FIRST_RENDER_BUDGET_MS,
        },
      }));
    },
    [patchCall],
  );

  const onViewResource = useCallback(
    (viewState: ActiveView, res: { cached?: boolean; fetchMs?: number }) => {
      patchCall(viewState.callId, (c) => ({ render: { ...(c.render ?? { kind: "view" as const }), kind: "view", uri: viewState.uri, resourceCached: res.cached, resourceMs: res.fetchMs } }));
    },
    [patchCall],
  );

  // ---- a conversational turn -----------------------------------------------------------------------------
  const runTurn = useCallback(
    async (utterance: string): Promise<TurnOutcome> => {
      const text = utterance.trim();
      const empty: TurnOutcome = { spoken: "", calls: [] };
      if (!text) return empty;
      speakerRef.current?.stop(); // barge-in
      lastUtterance.current = text;
      addTranscript({ role: "user", text });
      emitPanel({ type: "utterance", text });
      thinkingRef.current = true;
      recomputeStatus();
      setCaption("");
      const outcome: TurnOutcome = { spoken: "", calls: [] };
      const isDisplay = DEVICES[deviceRef.current].kind === "display";

      try {
        const res = await fetch("/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: SESSION_ID, utterance: text, model: settingsRef.current?.model }) });
        if (!res.ok || !res.body) throw new Error(`turn failed (${res.status})`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const handle = (ev: TurnEvent) => {
          switch (ev.type) {
            case "call_start": {
              const call: InspectorCall = { id: ev.callId, server: ev.server, tool: ev.tool, args: ev.args, origin: "brain", startedAt: ev.at, status: "running", utterance: text };
              setCalls((c) => [...c, call]);
              emitPanel({ type: "call_start", tool: ev.tool, server: ev.server });
              if (isDisplay && ev.uiResourceUri) {
                const d = deferred();
                pendingResults.current.set(ev.callId, d);
                openView({ callId: ev.callId, kind: "app", server: ev.server, tool: ev.tool, uri: ev.uiResourceUri, input: ev.args, resultPromise: d.promise });
              }
              break;
            }
            case "call_end": {
              const rec = ev.record;
              outcome.calls.push(rec);
              const result = rec.result as ToolResult | undefined;
              const d = pendingResults.current.get(rec.id);
              pendingResults.current.delete(rec.id);
              patchCall(rec.id, { status: rec.error || result?.isError ? "error" : "ok", record: rec });
              emitPanel({ type: "call_end", tool: rec.tool, server: rec.server });
              const carousel = looksLikeCarousel(rec.uiResourceUri, result?.structuredContent);
              if (!isDisplay) {
                setRender(rec.id, { kind: "suppressed", note: "voice-only device: views are never rendered" });
                break;
              }
              if (rec.error) {
                d?.reject(new Error(rec.error));
                setRender(rec.id, { kind: "none", note: rec.error });
                break;
              }
              const cur = viewRef.current;
              if (rec.uiResourceUri) {
                setRender(rec.id, { kind: "view", uri: rec.uiResourceUri, carousel });
                if (d && cur?.callId === rec.id && cur.uri === rec.uiResourceUri) {
                  d.resolve(result!);
                  setView((v) => (v && v.callId === rec.id ? { ...v, result } : v));
                } else {
                  d?.resolve(result!);
                  // The result carried a different/new ui resource than the tool definition (or none was declared).
                  openView({ callId: rec.id, kind: "app", server: rec.server, tool: rec.tool, uri: rec.uiResourceUri, input: rec.args, resultPromise: Promise.resolve(result!), result: result! });
                }
              } else {
                d?.resolve(result!);
                setRender(rec.id, { kind: "hydrated", note: "no UI resource: generic card rendered from structuredContent" });
                openView({ callId: rec.id, kind: "hydrated", server: rec.server, tool: rec.tool, input: rec.args, resultPromise: Promise.resolve(result!), result: result! });
              }
              break;
            }
            case "turn_end":
              outcome.spoken = ev.spoken;
              outcome.routing = ev.routing;
              break;
            case "error":
              throw new Error(ev.message);
            default:
              break;
          }
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) handle(JSON.parse(line) as TurnEvent);
          }
        }
        const entryId = addTranscript({ role: "assistant", text: outcome.spoken, tools: outcome.calls.map((c) => c.tool), routing: outcome.routing });
        void entryId;
        setCaption(outcome.spoken);
        emitPanel({ type: "reply", text: outcome.spoken });
        thinkingRef.current = false;
        recomputeStatus();
        void speakerRef.current?.speak(outcome.spoken).then((engine) => {
          if (engine !== "none") setVoiceEngine(engine);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        addTranscript({ role: "system", text: `Error: ${msg}` });
        outcome.spoken = outcome.spoken || `Error: ${msg}`;
        for (const [id, d] of pendingResults.current) {
          d.reject(new Error(msg));
          pendingResults.current.delete(id);
        }
      } finally {
        thinkingRef.current = false;
        recomputeStatus();
      }
      return outcome;
    },
    [addTranscript, emitPanel, openView, patchCall, recomputeStatus, setRender],
  );

  // ---- push to talk --------------------------------------------------------------------------------------
  const startListening = useCallback(() => {
    if (listeningRef.current) return;
    speakerRef.current?.stop(); // barge-in: talking over the assistant cuts it off
    if (!pttRef.current) {
      pttRef.current = new PushToTalk({
        onInterim: setInterim,
        onFinal: (t) => {
          setInterim("");
          if (t) void runTurn(t);
        },
        onListening: (l) => {
          listeningRef.current = l;
          recomputeStatus();
        },
        onError: (m) => setError(m),
      });
    }
    pttRef.current.start();
  }, [recomputeStatus, runTurn]);

  const stopListening = useCallback(() => pttRef.current?.stop(), []);

  // ---- elicitation (events stream) -----------------------------------------------------------------------
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as HubEvent;
      if (ev.type === "elicitation") {
        setElicitation(ev.request);
        if (ev.request.mode === "form") void speakerRef.current?.speak(ev.request.message);
        addTranscript({ role: "assistant", text: ev.request.message, tools: ["elicitation"] });
      } else if (ev.type === "elicitation_done") setElicitation((cur) => (cur?.id === ev.id ? undefined : cur));
    };
    return () => es.close();
  }, [addTranscript]);

  const answerElicitation = useCallback(async (id: string, res: ElicitationResponse) => {
    setElicitation(undefined);
    await fetch("/api/elicitation/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...res }) });
  }, []);

  // ---- settings / device -----------------------------------------------------------------------------------
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch, voice: { ...cur.voice, ...(patch.voice ?? {}) } };
      saveSettings(next);
      return next;
    });
  }, []);

  const setDevice = useCallback(
    (device: DeviceId) => {
      deviceRef.current = device;
      updateSettings({ device });
      setDisplayModeState("inline");
      addTranscript({ role: "system", text: `Switched to ${DEVICES[device].label}` });
      emitPanel({ type: "device", text: device });
    },
    [addTranscript, emitPanel, updateSettings],
  );

  const applyServers = useCallback(
    async (servers: Settings["servers"]) => {
      updateSettings({ servers });
      setConnecting(true);
      try {
        clearResourceCache();
        const res = await fetch("/api/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ servers }) });
        const body = (await res.json()) as { connections: ConnectionInfo[] };
        setConnections(body.connections);
      } finally {
        setConnecting(false);
      }
    },
    [updateSettings],
  );

  const reset = useCallback(async () => {
    speakerRef.current?.stop();
    await fetch("/api/session/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: SESSION_ID }) });
    setTranscript([]);
    setCalls([]);
    closeView();
    setCaption("");
    emitPanel({ type: "reset" });
  }, [closeView, emitPanel]);

  // ---- tools/call on behalf of a view ----------------------------------------------------------------------
  const viewCallTool = useCallback(
    async (v: ActiveView, params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult> => {
      const id = nid("vcall");
      const args = params.arguments ?? {};
      setCalls((c) => [...c, { id, server: v.server, tool: params.name, args, origin: "view", startedAt: Date.now(), status: "running", utterance: `(from ${v.tool} view)` }]);
      const res = await fetch("/api/mcp/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server: v.server, tool: params.name, args, origin: "view" }) });
      const rec = (await res.json()) as CallRecord;
      patchCall(id, { status: rec.error || rec.result?.isError ? "error" : "ok", record: rec });
      if (rec.error || !rec.result) throw new Error(rec.error ?? "tool call failed");
      return rec.result;
    },
    [patchCall],
  );

  const requestDisplayMode = useCallback((mode: "inline" | "fullscreen" | "pip"): "inline" | "fullscreen" => {
    const granted = mode === "fullscreen" ? "fullscreen" : "inline";
    setDisplayModeState(granted);
    return granted;
  }, []);

  // ---- panels + export + script driver ---------------------------------------------------------------------
  const subscribePanel = useCallback((cb: (e: PanelSimEvent) => void) => {
    panelSubs.current.add(cb);
    return () => {
      panelSubs.current.delete(cb);
    };
  }, []);

  const exportSession = useCallback((): SessionExport => {
    return {
      exportedAt: new Date().toISOString(),
      llmMode: configRef.current?.llmMode ?? "offline",
      device: deviceRef.current,
      servers: connections.map((c) => ({ id: c.id, name: c.name, url: c.url, protocolVersion: c.protocolVersion, serverInfo: c.serverInfo })),
      transcript,
      calls,
    };
  }, [calls, connections, transcript]);

  const driver = useMemo<Driver>(
    () => ({
      get defaultServer() {
        return settingsRef.current?.servers[0]?.id ?? "butler";
      },
      say: (u) => runTurn(u),
      callTool: async (server, tool, args) => {
        const id = nid("scall");
        setCalls((c) => [...c, { id, server, tool, args, origin: "script", startedAt: Date.now(), status: "running" }]);
        const res = await fetch("/api/mcp/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server, tool, args, origin: "script" }) });
        const rec = (await res.json()) as CallRecord;
        patchCall(id, { status: rec.error || rec.result?.isError ? "error" : "ok", record: rec });
        return rec;
      },
      setDevice: (d) => {
        if (d in DEVICES) setDevice(d as DeviceId);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }),
    [patchCall, runTurn, setDevice],
  );

  return {
    config,
    settings,
    connections,
    connecting,
    transcript,
    calls,
    view,
    displayMode,
    status,
    interim,
    elicitation,
    caption,
    voiceEngine,
    error,
    sttOk,
    sessionId: SESSION_ID,
    device: settings?.device ?? "display-15",
    runTurn,
    startListening,
    stopListening,
    answerElicitation,
    updateSettings,
    setDevice,
    applyServers,
    refreshConnections,
    reset,
    viewCallTool,
    requestDisplayMode,
    setDisplayMode: setDisplayModeState,
    closeView,
    subscribePanel,
    exportSession,
    driver,
    onViewMetrics,
    onViewResource,
    clearError: () => setError(undefined),
    stopSpeaking: () => speakerRef.current?.stop(),
    lastUtterance: () => lastUtterance.current,
  };
}

export type Simulator = ReturnType<typeof useSimulator>;
