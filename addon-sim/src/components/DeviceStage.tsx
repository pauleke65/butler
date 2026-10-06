"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEVICES, fitScale, type DeviceSpec } from "@/lib/devices";
import type { Simulator } from "@/lib/state/use-simulator";
import { AppView } from "./AppView";
import { HydratedCard } from "./HydratedCard";

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date>();
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return <span className={className}>{now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</span>;
}

const STATUS_LABEL = { idle: "", listening: "Listening", thinking: "Thinking", speaking: "Speaking" } as const;

/** The 1:1 display screen content, laid out at the device's native resolution. */
function DisplayScreen({ sim, spec }: { sim: Simulator; spec: DeviceSpec }) {
  const view = sim.view;
  const tool = view ? sim.connections.flatMap((c) => c.tools).find((t) => t.server === view.server && t.name === view.tool) : undefined;
  const fullscreen = !!view && sim.displayMode === "fullscreen";
  const base = spec.baseFontPx;
  return (
    <div className="relative h-full w-full overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,#13203b_0%,#080d18_60%)] text-slate-100" style={{ fontSize: base }}>
      {/* status bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-[3.2%] pt-[1.8%] text-slate-300" style={{ fontSize: base * 0.8 }}>
        <Clock />
        <span data-testid="device-status" className={`rounded-full px-4 py-1 transition-opacity ${sim.status === "idle" ? "opacity-0" : "bg-white/10 opacity-100"}`}>
          {STATUS_LABEL[sim.status]}
          {sim.status === "listening" && sim.interim ? `: ${sim.interim}` : ""}
        </span>
      </div>

      {/* content */}
      {!view || view.kind === "hydrated" ? (
        <div className="absolute inset-0 grid place-items-center px-[6%] pb-[9%] pt-[7%]">
          {view?.kind === "hydrated" ? (
            <div className="max-h-[78%] w-full max-w-[86%] overflow-auto rounded-[28px] bg-white/[0.06] ring-1 ring-white/10">
              <HydratedCard tool={view.tool} result={view.result} />
            </div>
          ) : (
            <div className="text-center">
              <Clock className="block font-light tabular-nums text-slate-100" />
              <div className="mt-2 text-slate-400" style={{ fontSize: base * 0.75 }}>
                {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
              </div>
              <div className="mt-10 text-slate-500" style={{ fontSize: base * 0.7 }}>
                Hold space to talk, or type below
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className={fullscreen ? "" : "absolute inset-x-0 top-[9%] flex justify-center"}>
          <AppView
            key={view.id}
            view={view}
            tool={tool}
            sandboxOrigin={sim.config?.sandboxOrigin ?? "http://localhost:3001"}
            device={spec}
            fullscreen={fullscreen}
            onCallTool={(p) => sim.viewCallTool(view, p)}
            onRequestDisplayMode={sim.requestDisplayMode}
            onExitFullscreen={() => sim.setDisplayMode("inline")}
            onMetrics={(m) => sim.onViewMetrics(view, m)}
            onResource={(r) => sim.onViewResource(view, r)}
          />
        </div>
      )}

      {/* caption */}
      {sim.caption && !fullscreen && (
        <div data-testid="device-caption" className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-[6%] pb-[2.2%] pt-[4%] text-center text-slate-100" style={{ fontSize: base * 0.9 }}>
          {sim.caption}
        </div>
      )}
    </div>
  );
}

function DisplayDevice({ sim, spec, cw, ch }: { sim: Simulator; spec: DeviceSpec; cw: number; ch: number }) {
  const frameW = spec.width + spec.bezel * 2;
  const frameH = spec.height + spec.bezel * 2 + 90; // base/stand
  const scale = useMemo(() => fitScale(cw - 8, ch - 8, frameW, frameH), [cw, ch, frameW, frameH]);
  return (
    <div style={{ width: frameW * scale, height: frameH * scale }} className="relative" data-testid="device-frame" data-device={spec.id} data-scale={scale.toFixed(3)}>
      <div style={{ width: frameW, height: frameH, transform: `scale(${scale})`, transformOrigin: "top left" }} className="absolute left-0 top-0">
        <div className="relative rounded-[48px] bg-gradient-to-b from-[#1b2233] to-[#0b0f19] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] ring-1 ring-white/10" style={{ width: frameW, height: spec.height + spec.bezel * 2, padding: spec.bezel }}>
          <div className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10" style={{ top: spec.bezel * 0.36, width: 12, height: 12 }} aria-hidden />
          <div className="overflow-hidden rounded-[18px] bg-black ring-1 ring-black" style={{ width: spec.width, height: spec.height }} data-testid="device-screen">
            <DisplayScreen sim={sim} spec={spec} />
          </div>
        </div>
        {/* stand */}
        <div className="mx-auto h-[70px] w-[22%] rounded-b-[34px] bg-gradient-to-b from-[#161c2b] to-[#0a0d15] ring-1 ring-white/5" aria-hidden />
        <div className="mx-auto h-[14px] w-[34%] rounded-full bg-black/60 blur-[6px]" aria-hidden />
      </div>
    </div>
  );
}

const RING_COLOR = {
  idle: "from-sky-500/40 via-sky-300/10 to-sky-500/40",
  listening: "from-sky-400 via-cyan-200 to-sky-400",
  thinking: "from-indigo-400 via-fuchsia-300 to-transparent",
  speaking: "from-emerald-300 via-teal-200 to-emerald-300",
} as const;

/** Voice-only device: never renders a view, only a light ring. */
function SpeakerDevice({ sim, size }: { sim: Simulator; size: number }) {
  const s = Math.max(180, Math.min(size, 420));
  return (
    <div className="flex flex-col items-center gap-6" data-testid="device-frame" data-device="speaker">
      <div className="relative grid place-items-center" style={{ width: s, height: s }} role="img" aria-label={`Speaker, ${STATUS_LABEL[sim.status] || "idle"}`}>
        <div className="absolute inset-0 rounded-full bg-gradient-to-b from-[#202a40] to-[#0a0e17] shadow-[0_40px_90px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10" />
        <div data-testid="light-ring" data-state={sim.status} className={`ring-${sim.status} absolute rounded-full bg-gradient-to-tr ${RING_COLOR[sim.status]} p-[5px]`} style={{ inset: s * 0.08 }}>
          <div className="h-full w-full rounded-full bg-[#0a0e17]" />
        </div>
        <div className="absolute rounded-full bg-[radial-gradient(circle_at_50%_30%,#1a2337,#070a12)] ring-1 ring-white/5" style={{ inset: s * 0.15 }} />
        <div className="absolute text-center text-sm text-slate-400" style={{ fontSize: s * 0.05 }}>
          {STATUS_LABEL[sim.status] || "Ready"}
        </div>
      </div>
      <div data-testid="device-caption" className="min-h-[3.5rem] max-w-md text-center text-lg text-slate-200">
        {sim.caption || <span className="text-slate-500">Voice only: no screen. Replies are spoken and captioned.</span>}
      </div>
      {sim.view && <div className="rounded-full bg-white/5 px-4 py-1 text-sm text-slate-400">A view was produced but this device has no screen</div>}
    </div>
  );
}

export function DeviceStage({ sim }: { sim: Simulator }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const spec = DEVICES[sim.device];
  return (
    <div ref={ref} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden" data-testid="stage">
      {w > 0 && (spec.kind === "display" ? <DisplayDevice sim={sim} spec={spec} cw={w} ch={h} /> : <SpeakerDevice sim={sim} size={Math.min(w, h) * 0.7} />)}
    </div>
  );
}
