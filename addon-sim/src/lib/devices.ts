export type DeviceId = "display-8" | "display-15" | "speaker";

export interface DeviceSpec {
  id: DeviceId;
  label: string;
  kind: "display" | "speaker";
  /** Native screen resolution in CSS px (display only). */
  width: number;
  height: number;
  /** Bezel thickness in native px. */
  bezel: number;
  /** Baseline font size the host context advertises (far-field legibility). */
  baseFontPx: number;
}

export const DEVICES: Record<DeviceId, DeviceSpec> = {
  "display-8": { id: "display-8", label: "Smart display 8", kind: "display", width: 1280, height: 800, bezel: 36, baseFontPx: 24 },
  "display-15": { id: "display-15", label: "Smart display 15", kind: "display", width: 1920, height: 1080, bezel: 44, baseFontPx: 28 },
  speaker: { id: "speaker", label: "Speaker", kind: "speaker", width: 0, height: 0, bezel: 0, baseFontPx: 0 },
};

export const DEVICE_ORDER: DeviceId[] = ["display-8", "display-15", "speaker"];

export function isDeviceId(v: unknown): v is DeviceId {
  return typeof v === "string" && v in DEVICES;
}

/** Scale that fits a (w x h) frame inside a (cw x ch) container without upscaling beyond 1. */
export function fitScale(cw: number, ch: number, w: number, h: number): number {
  if (cw <= 0 || ch <= 0 || w <= 0 || h <= 0) return 1;
  return Math.min(1, cw / w, ch / h);
}
