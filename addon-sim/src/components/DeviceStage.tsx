"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEVICES, fitScale, type DeviceSpec } from "@/lib/devices";
import type { Simulator } from "@/lib/state/use-simulator";
import { AppView } from "./AppView";
import { HydratedCard } from "./HydratedCard";
import { MicIcon, WaveIcon } from "./icons";

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

function Clock({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [now, setNow] = useState<Date>();
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className={className} style={style}>
      {now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
    </span>
  );
}

const STATUS_LABEL = { idle: "", listening: "Listening", thinking: "Thinking", speaking: "Speaking" } as const;

/**
 * Smart-display layout, after the Alexa+ MCP design guide: content is authored on a canvas of 768 units wide on an
 * 8-inch screen and zoomed 1.667x, so 1 unit = U device pixels on both screen sizes (the 15-inch gets more room, not
 * bigger type). The reply bubble takes the left column and the add-on's view the rest.
 */
export const U = 1.667;
const u = (n: number) => Math.round(n * U * 10) / 10;
const LAYOUT = { left: 40, right: 32, top: 54, bottom: 18, bubble: 200, gap: 24 } as const;

/**
 * The inline slot (device px): from the bubble column to the screen's right edge. The screen margin on the right is
 * handed to the view as a safe-area inset, so its carousel can bleed to the bezel while its cards keep the margin.
 */
export function inlineSlot(spec: DeviceSpec): { width: number; maxHeight: number; insetRight: number } {
  return {
    width: Math.round(spec.width - u(LAYOUT.left + LAYOUT.bubble + LAYOUT.gap)),
    maxHeight: Math.round(spec.height - u(LAYOUT.top + LAYOUT.bottom)),
    insetRight: Math.round(u(LAYOUT.right)),
  };
}

const C = {
  canvas: "#173055",
  text: "#e9eff8",
  text2: "#b7c6da",
  text3: "#8e9fb5",
  bubble: "#408eff",
  onBubble: "#0a1f3f",
  iconBtn: "#19283c",
  dot: "#8db8ff",
  dotOff: "#3a5683",
};

/**
 * Alexa's reply bubble. Its outline steps rather than closing as a rectangle: a foot drops from the bottom-left (it
 * carries who is answering) and meets the body in a concave fillet, as in the Alexa+ design guide's conversation screens.
 */
function ReplyBubble({ text, large, from }: { text: string; large?: boolean; from?: string }) {
  const long = text.length > 150;
  const r = u(20);
  const f = u(14); // fillet where the foot meets the body
  return (
    <div key={text} data-testid="device-caption" className="bubble-in" style={{ color: C.onBubble }}>
      <div
        style={{
          background: C.bubble,
          borderRadius: from ? `${r}px ${r}px ${r}px 0` : r,
          padding: `${u(12)}px ${u(15)}px ${u(13)}px`,
          fontSize: large ? u(20) : long ? u(14.5) : u(16.5),
          fontWeight: 500,
          lineHeight: 1.3,
          letterSpacing: "-0.005em",
          textWrap: "pretty",
        }}
      >
        {text}
      </div>
      {from && (
        // the foot and its fillet overlap the body by 2 px so no hairline seam shows when the device is scaled
        <div className="relative flex w-fit items-center" style={{ background: C.bubble, borderRadius: `0 0 ${r}px ${r}px`, marginTop: -2, padding: `${u(1) + 2}px ${u(15)}px ${u(10)}px ${u(11)}px`, gap: u(6), fontSize: u(12), fontWeight: 600 }}>
          <span className="grid place-items-center rounded-full" style={{ width: u(18), height: u(18), background: C.onBubble, color: C.bubble }}>
            <WaveIcon size={u(11)} />
          </span>
          {from}
          <span aria-hidden className="absolute" style={{ left: "calc(100% - 2px)", top: 0, width: f + 2, height: f + 2, background: `radial-gradient(circle at 100% 100%, transparent ${f - 0.5}px, ${C.bubble} ${f}px)` }} />
        </div>
      )}
    </div>
  );
}

function PageDots() {
  return (
    <div aria-hidden className="absolute flex flex-col items-center" style={{ left: u(15), top: "50%", transform: "translateY(-50%)", gap: u(3) }}>
      <span style={{ width: u(4), height: u(11), borderRadius: 99, background: C.dot }} />
      <span style={{ width: u(4), height: u(4), borderRadius: 99, background: C.dotOff }} />
      <span style={{ width: u(4), height: u(4), borderRadius: 99, background: C.dotOff }} />
    </div>
  );
}

/** The 1:1 display screen content, laid out at the device's native resolution. */
function DisplayScreen({ sim, spec }: { sim: Simulator; spec: DeviceSpec }) {
  const view = sim.view;
  const tool = view ? sim.connections.flatMap((c) => c.tools).find((t) => t.server === view.server && t.name === view.tool) : undefined;
  const fullscreen = !!view && view.kind === "app" && sim.displayMode === "fullscreen";
  const topic = view ? (sim.connections.find((c) => c.id === view.server)?.name ?? view.server) : "";
  const lastUser = [...sim.transcript].reverse().find((e) => e.role === "user")?.text;
  const said = sim.status === "listening" && sim.interim ? sim.interim : lastUser;
  const slot = inlineSlot(spec);
  const conversing = !!view || !!sim.caption;

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: C.canvas, color: C.text, fontSize: u(16) }}>
      {/* top bar: topic left, status and clock right */}
      {!fullscreen && (
        <div className="absolute z-10 flex items-center justify-between" style={{ left: u(LAYOUT.left), right: u(LAYOUT.right), top: u(14), height: u(30) }}>
          <span style={{ fontSize: u(13), color: C.text2, fontWeight: 500 }}>{topic}</span>
          <div className="flex items-center" style={{ gap: u(10) }}>
            <span
              data-testid="device-status"
              className="flex items-center transition-opacity duration-200"
              style={{ gap: u(6), fontSize: u(12), color: C.text2, background: C.iconBtn, borderRadius: 99, padding: `${u(4)}px ${u(10)}px`, opacity: sim.status === "idle" ? 0 : 1 }}
            >
              {sim.status === "listening" && <MicIcon size={u(12)} />}
              {STATUS_LABEL[sim.status]}
            </span>
            {conversing && <Clock className="tnum" style={{ fontSize: u(13), color: C.text2 }} />}
          </div>
        </div>
      )}

      {!conversing ? (
        /* home: clock and date */
        <div className="absolute inset-0 flex flex-col justify-center" style={{ paddingLeft: u(56) }}>
          <Clock className="tnum" style={{ fontSize: u(64), fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1 }} />
          <div style={{ fontSize: u(18), color: C.text2, marginTop: u(8) }}>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
          <div style={{ fontSize: u(13), color: C.text3, marginTop: u(28) }}>{said ? `“${said}”` : "Hold Space to talk, or type below"}</div>
        </div>
      ) : (
        <>
          {!fullscreen && <PageDots />}
          {/* the conversation group sits centred on the screen, bubble and card top-aligned (guide's checkout layout) */}
          <div
            className="absolute flex flex-col"
            style={fullscreen ? { inset: 0 } : { left: u(LAYOUT.left), right: 0, top: u(LAYOUT.top), bottom: u(LAYOUT.bottom), justifyContent: "center" }}
          >
          <div className="flex min-h-0 items-start" style={fullscreen ? { height: "100%" } : { gap: u(LAYOUT.gap), maxHeight: "100%" }}>
            <div className="flex shrink-0 flex-col" style={{ width: view ? u(LAYOUT.bubble) : u(380), gap: u(10), display: fullscreen ? "none" : "flex" }}>
              {said && (
                <p className="line-clamp-3" style={{ fontSize: u(12.5), color: C.text3, lineHeight: 1.35 }}>
                  “{said}”
                </p>
              )}
              {sim.caption && <ReplyBubble text={sim.caption} large={!view} from={topic || undefined} />}
            </div>
            <div className="relative min-w-0 flex-1 self-stretch" style={fullscreen ? undefined : { maxHeight: "100%" }}>
              {view?.kind === "hydrated" ? (
                <div className="max-h-full overflow-auto" style={{ background: "#0e1c30", borderRadius: u(22), marginRight: u(LAYOUT.right) }}>
                  <HydratedCard tool={view.tool} result={view.result} />
                </div>
              ) : view ? (
                <AppView
                  key={view.id}
                  view={view}
                  tool={tool}
                  sandboxOrigin={sim.config?.sandboxOrigin ?? "http://localhost:3001"}
                  device={spec}
                  slot={slot}
                  fullscreen={fullscreen}
                  onCallTool={(p) => sim.viewCallTool(view, p)}
                  onRequestDisplayMode={sim.requestDisplayMode}
                  onExitFullscreen={() => sim.setDisplayMode("inline")}
                  onMetrics={(m) => sim.onViewMetrics(view, m)}
                  onResource={(r) => sim.onViewResource(view, r)}
                />
              ) : null}
            </div>
          </div>
          </div>
        </>
      )}

      {/* Echo light bar */}
      <div aria-hidden className="light-bar absolute inset-x-0 bottom-0 z-20" data-state={sim.status} style={{ height: u(5), transformOrigin: "bottom" }} />
    </div>
  );
}

function DisplayDevice({ sim, spec, cw, ch }: { sim: Simulator; spec: DeviceSpec; cw: number; ch: number }) {
  const frameW = spec.width + spec.bezel * 2;
  const frameH = spec.height + spec.bezel * 2;
  const scale = useMemo(() => fitScale(cw - 8, ch - 28, frameW, frameH), [cw, ch, frameW, frameH]);
  return (
    <div style={{ width: frameW * scale, height: frameH * scale }} className="relative" data-testid="device-frame" data-device={spec.id} data-scale={scale.toFixed(3)}>
      {/* the screen's light falling on the wall behind it, and the device's contact shadow on the surface below */}
      <div aria-hidden className="pointer-events-none absolute" style={{ inset: "-14% -10%", background: "radial-gradient(50% 50% at 50% 48%, rgba(64,142,255,0.22), rgba(40,96,190,0.08) 55%, transparent 76%)", filter: "blur(28px)" }} />
      <div aria-hidden className="pointer-events-none absolute left-[8%] right-[8%] rounded-[50%]" style={{ bottom: -18, height: 36, background: "rgba(0,0,0,0.65)", filter: "blur(16px)" }} />
      <div style={{ width: frameW, height: frameH, transform: `scale(${scale})`, transformOrigin: "top left" }} className="absolute left-0 top-0">
        <div
          className="relative"
          style={{
            width: frameW,
            height: frameH,
            padding: spec.bezel,
            background: "linear-gradient(180deg, #1c2027 0%, #12151a 100%)",
            borderRadius: spec.bezel * 1.5,
            boxShadow: "inset 0 1.5px 0 rgba(255,255,255,0.09), inset 0 -2px 0 rgba(0,0,0,0.55), 0 60px 110px -40px rgba(0,0,0,0.95), 0 14px 30px -14px rgba(0,0,0,0.8)",
          }}
        >
          <div className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{ top: spec.bezel * 0.42, width: 10, height: 10, background: "#05070a", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.12)" }} aria-hidden />
          <div className="overflow-hidden" style={{ width: spec.width, height: spec.height, borderRadius: spec.bezel * 0.6, boxShadow: "0 0 0 1px rgba(0,0,0,0.7)" }} data-testid="device-screen">
            <DisplayScreen sim={sim} spec={spec} />
          </div>
        </div>
      </div>
    </div>
  );
}

const RING_COLOR = {
  idle: "from-[#1a6bff]/40 via-[#00caff]/10 to-[#1a6bff]/40",
  listening: "from-[#00caff] via-[#7fe3ff] to-[#1a6bff]",
  thinking: "from-[#1a6bff] via-[#00caff] to-transparent",
  speaking: "from-[#00caff] via-[#1a6bff] to-[#00caff]",
} as const;

/** Voice-only device: never renders a view, only a light ring. */
function SpeakerDevice({ sim, size }: { sim: Simulator; size: number }) {
  const s = Math.max(180, Math.min(size, 420));
  return (
    <div className="flex flex-col items-center gap-6" data-testid="device-frame" data-device="speaker">
      <div className="relative grid place-items-center" style={{ width: s, height: s }} role="img" aria-label={`Speaker, ${STATUS_LABEL[sim.status] || "idle"}`}>
        <div className="absolute inset-0 rounded-full bg-[#14181e] shadow-[0_40px_90px_-24px_rgba(0,0,0,0.9)]" />
        <div data-testid="light-ring" data-state={sim.status} className={`ring-${sim.status} absolute rounded-full bg-gradient-to-tr ${RING_COLOR[sim.status]} p-[5px]`} style={{ inset: s * 0.08 }}>
          <div className="h-full w-full rounded-full bg-[#14181e]" />
        </div>
        <div className="absolute rounded-full bg-[#0f1319]" style={{ inset: s * 0.15 }} />
        <div className="absolute text-center text-slate-400" style={{ fontSize: s * 0.05 }}>
          {STATUS_LABEL[sim.status] || "Ready"}
        </div>
      </div>
      <div data-testid="device-caption" className="min-h-[3.5rem] max-w-md text-center text-lg text-slate-200">
        {sim.caption || <span className="text-slate-500">Voice only: no screen. Replies are spoken and captioned.</span>}
      </div>
      {sim.view && <div className="rounded-full bg-surface2 px-4 py-1 text-sm text-slate-400">A view was produced but this device has no screen</div>}
    </div>
  );
}

export function DeviceStage({ sim }: { sim: Simulator }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const spec = DEVICES[sim.device];
  return (
    <div ref={ref} className="relative grid min-h-[260px] min-w-0 flex-1 place-items-center overflow-hidden lg:min-h-0" data-testid="stage">
      {w > 0 && (spec.kind === "display" ? <DisplayDevice sim={sim} spec={spec} cw={w} ch={h} /> : <SpeakerDevice sim={sim} size={Math.min(w, h) * 0.7} />)}
    </div>
  );
}
