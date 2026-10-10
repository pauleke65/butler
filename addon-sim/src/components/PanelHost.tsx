"use client";

import { useEffect, useRef, useState } from "react";
import { loadPanels, type LoadedPanel } from "@/lib/panels/load";
import type { Panel, PanelCtx } from "@/lib/panels/types";
import type { Simulator } from "@/lib/state/use-simulator";
import { ChevronIcon } from "./icons";

/** One panel as a slim card beside the device. A panel can ask for attention by dispatching a bubbling
 *  `panel-attention` event ({ tone: "alert" | "info" }); the card then lights up briefly. */
function PanelSection({ panel, sim }: { panel: Panel; sim: Simulator }) {
  const [open, setOpen] = useState(true);
  const [tone, setTone] = useState<"alert" | "info" | undefined>();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      const next = (e as CustomEvent<{ tone?: string }>).detail?.tone === "alert" ? "alert" : "info";
      setTone(next);
      clearTimeout(t);
      t = setTimeout(() => setTone(undefined), next === "alert" ? 2600 : 1200);
    };
    el.addEventListener("panel-attention", on);
    return () => {
      el.removeEventListener("panel-attention", on);
      clearTimeout(t);
    };
  }, []);
  const glow =
    tone === "alert"
      ? "bg-[#2a1418] shadow-[inset_0_0_0_2px_#e5484d]"
      : tone === "info"
        ? "bg-[#1d1813] shadow-[inset_0_0_0_2px_rgba(255,122,26,0.5)]"
        : "bg-surface shadow-[inset_0_0_0_0_transparent]";
  return (
    // bounded to the dock so the alert ring always closes on all four sides; the panel body scrolls inside it
    <section ref={ref} data-attention={tone ?? "none"} className={`flex max-h-full min-h-0 shrink flex-col rounded-[20px] transition-[background-color,box-shadow] duration-700 ease-out ${glow}`}>
      {panel.chrome !== "bare" && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full shrink-0 items-center gap-2 px-4 pb-1 pt-3.5 text-left text-[14px] font-semibold text-fg">
          <span className="flex-1">{panel.title}</span>
          <ChevronIcon size={16} open={open} className="text-slate-500" />
        </button>
      )}
      <div hidden={!open} className="min-h-0 flex-1 overflow-y-auto scroll-thin [mask-image:linear-gradient(to_bottom,#000_calc(100%-20px),transparent)]">
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
      {err && <div className="m-3 rounded-xl bg-[#3d1b27] p-2.5 text-xs text-red-200">Panel failed: {err}</div>}
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
    <div className="flex min-h-0 w-full shrink-0 flex-col gap-4 lg:w-[284px]" aria-label="Panels">
      {loaded.map((l, i) =>
        l.panel ? (
          <PanelSection key={`${l.url}#${l.panel.id}`} panel={l.panel} sim={sim} />
        ) : (
          <div key={i} className="rounded-[20px] bg-[#3d1b27] p-3 text-xs text-red-200">
            Could not load panel {l.url}: {l.error}
          </div>
        ),
      )}
    </div>
  );
}
