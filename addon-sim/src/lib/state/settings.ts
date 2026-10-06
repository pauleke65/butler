import type { DeviceId } from "../devices";
import type { ServerConfig } from "../mcp/types";

export interface Settings {
  servers: ServerConfig[];
  device: DeviceId;
  model: string;
  voice: {
    /** "auto" = Polly when the server allows it, else browser speechSynthesis. */
    engine: "auto" | "browser" | "off";
    pollyVoiceId: string;
    browserVoiceName: string;
  };
  panelUrls: string[];
}

const KEY = "addon-sim.settings.v1";

export function loadSettings(): Partial<Settings> | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}

/** Stored settings win, but missing keys come from the server defaults. */
export function mergeSettings(defaults: Settings, stored?: Partial<Settings>): Settings {
  if (!stored) return defaults;
  return {
    servers: stored.servers?.length ? stored.servers : defaults.servers,
    device: stored.device ?? defaults.device,
    model: stored.model ?? defaults.model,
    voice: { ...defaults.voice, ...stored.voice },
    panelUrls: stored.panelUrls?.length ? stored.panelUrls : defaults.panelUrls,
  };
}
