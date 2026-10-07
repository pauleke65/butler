import type { ServerConfig } from "./mcp/types";

export const DEFAULT_BUTLER_SERVER: ServerConfig = {
  id: "butler",
  name: "Butler",
  url: "http://localhost:8000/mcp",
  auth: { type: "bearer", token: "local-sim-token" },
  invocationName: "Butler",
  enabled: true,
};

/** Server list from `SIM_SERVERS` (JSON array) or the default local Butler server. */
export function defaultServers(env: Record<string, string | undefined> = process.env): ServerConfig[] {
  const raw = env.SIM_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ServerConfig[];
      if (Array.isArray(parsed) && parsed.length) return parsed.map((s) => ({ enabled: true, ...s, auth: s.auth ?? { type: "none" as const } }));
    } catch {
      /* fall through to default */
    }
  }
  return [DEFAULT_BUTLER_SERVER];
}

export interface PublicConfig {
  servers: ServerConfig[];
  llmMode: "offline" | "bedrock";
  model: string;
  voice: { pollyVoiceId: string; pollyEnabled: boolean };
  panelUrls: string[];
  panelEnv: Record<string, string>;
  sandboxOrigin: string;
  devices: string[];
}

export function panelEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["DEBUG_API_URL", "DEBUG_API_TOKEN"]) if (env[k]) out[k] = env[k]!;
  for (const [k, v] of Object.entries(env)) if (k.startsWith("PANEL_ENV_") && v) out[k.slice("PANEL_ENV_".length)] = v;
  return out;
}

export function publicConfig(env: Record<string, string | undefined> = process.env): PublicConfig {
  const llmMode = env.LLM_MODE === "bedrock" ? "bedrock" : "offline";
  return {
    servers: defaultServers(env),
    llmMode,
    model: env.BEDROCK_MODEL_BRAIN || "us.amazon.nova-2-lite-v1:0",
    voice: { pollyVoiceId: env.POLLY_VOICE_ID || "Joanna", pollyEnabled: llmMode === "bedrock" },
    panelUrls: (env.PANEL_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    panelEnv: panelEnv(env),
    sandboxOrigin: env.SANDBOX_ORIGIN || `http://localhost:${env.SANDBOX_PORT || 3001}`,
    devices: ["display-8", "display-15", "speaker"],
  };
}
