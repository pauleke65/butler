import type { Panel } from "./types";

export interface LoadedPanel {
  url: string;
  panel?: Panel;
  error?: string;
}

function isPanel(v: unknown): v is Panel {
  const p = v as Panel | undefined;
  return !!p && typeof p.id === "string" && typeof p.title === "string" && typeof p.mount === "function";
}

/** Normalise a module namespace to a list of panels (default / `panel` / `panels` exports). */
export function panelsFromModule(mod: Record<string, unknown>): Panel[] {
  const candidates = [mod.default, mod.panel, ...(Array.isArray(mod.panels) ? mod.panels : [mod.panels])].flat();
  const seen = new Set<string>();
  return candidates.filter(isPanel).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** Load panel modules by URL (browser only; `import()` of a URL is not bundled). */
export async function loadPanels(urls: string[]): Promise<LoadedPanel[]> {
  const out: LoadedPanel[] = [];
  for (const url of urls) {
    try {
      const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as Record<string, unknown>;
      const panels = panelsFromModule(mod);
      if (!panels.length) out.push({ url, error: "module exports no panel ({ id, title, mount })" });
      for (const panel of panels) out.push({ url, panel });
    } catch (err) {
      out.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
