"use client";

import { useEffect, useRef, useState } from "react";
import { loadPanels, type LoadedPanel } from "@/lib/panels/load";
import type { Panel, PanelCtx } from "@/lib/panels/types";
import type { Simulator } from "@/lib/state/use-simulator";

function PanelSection({ panel, sim }: { panel: Panel; sim: Simulator }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 pt-2 text-left text-[11px] font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200">
        <span className="inline-block w-3 text-slate-500">{open ? "▾" : "▸"}</span>
        {panel.title}
      </button>
      <div hidden={!open}>
        <MountedPanel panel={panel} sim={sim} />
      </div>
    </section>
  );
}

function MountedPanel({ panel, sim }: { panel: Panel; sim: Simulator }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string>();
  const simRef = useRef(sim);
  simRef.current = sim;
  useEffect(() => {
    const el = ref.current!;
    let cleanup: void | (() => void);
    let disposed = false;
    const ctx: PanelCtx = {
      sessionId: simRef.current.sessionId,
      env: simRef.current.config?.panelEnv ?? {},
      theme: "dark",
      fetch: (url, init) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase() === "authorization" ? "x-proxy-authorization" : k] = v;
        return fetch(`/api/proxy?url=${encodeURIComponent(url)}`, { headers });
      },
      onEvent: (cb) => simRef.current.subscribePanel(cb),
    };
    Promise.resolve(panel.mount(el, ctx)).then(
      (c) => {
        if (disposed) (c as undefined | (() => void))?.();
        else cleanup = c;
      },
      (e) => setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      disposed = true;
      try {
        cleanup?.();
      } catch {
        /* ignore */
      }
      el.replaceChildren();
    };
  }, [panel]);
  return (
    <>
      {err && <div className="m-2 rounded bg-red-500/15 p-2 text-xs text-red-200">Panel failed: {err}</div>}
      <div ref={ref} data-testid={`panel-${panel.id}`} />
    </>
  );
}

/** Loads panel plugins by URL and mounts each into a card. */
export function PanelHost({ sim }: { sim: Simulator }) {
  const urls = sim.settings?.panelUrls;
  const key = urls?.join("|");
  const [loaded, setLoaded] = useState<LoadedPanel[]>([]);
  useEffect(() => {
    if (!urls?.length) {
      setLoaded([]);
      return;
    }
    let cancelled = false;
    void loadPanels(urls).then((l) => !cancelled && setLoaded(l));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!loaded.length) return null;
  return (
    <div className="flex min-h-0 max-h-[46%] shrink-0 flex-col overflow-y-auto border-b border-line scroll-thin" aria-label="Panels">
      {loaded.map((l, i) =>
        l.panel ? (
          <PanelSection key={`${l.url}#${l.panel.id}`} panel={l.panel} sim={sim} />
        ) : (
          <div key={i} className="m-2 rounded bg-red-500/15 p-2 text-xs text-red-200">
            Could not load panel {l.url}: {l.error}
          </div>
        ),
      )}
    </div>
  );
}
