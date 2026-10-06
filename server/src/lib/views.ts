/** The six MCP Apps views (contracts §4): URIs, titles and where their built HTML lives. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VIEW_NAMES = ["plan", "options", "receipt", "actions", "rule", "rules"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const VIEW_URI: Record<ViewName, string> = {
  plan: "ui://butler/plan",
  options: "ui://butler/options",
  receipt: "ui://butler/receipt",
  actions: "ui://butler/actions",
  rule: "ui://butler/rule",
  rules: "ui://butler/rules",
};

export const VIEW_INFO: Record<ViewName, { title: string; description: string }> = {
  plan: { title: "Butler plan", description: "A plan with what Butler is handling and what needs the customer, as a list with status chips." },
  options: { title: "Butler options", description: "A carousel of options for a pending decision, each with a Choose button." },
  receipt: { title: "Butler receipt", description: "One action Butler took (or was stopped from taking) with the reason and the rule that applied." },
  actions: { title: "Butler actions", description: "A carousel of recent actions; fullscreen shows the full ledger with filters." },
  rule: { title: "Butler rule", description: "A single rule, either a draft to confirm or an active rule." },
  rules: { title: "Butler rules", description: "All active rules grouped as allowed, ask first and never." },
};

export function isViewUri(uri: string): ViewName | undefined {
  return VIEW_NAMES.find((v) => VIEW_URI[v] === uri);
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_UI_DIST = resolve(here, "../../ui/dist");

const PLACEHOLDER = (view: ViewName): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Butler ${view}</title>` +
  `<style>body{margin:0;padding:24px;font:24px/1.6 system-ui,sans-serif;background:#0f172a;color:#e2e8f0}</style></head>` +
  `<body><p>Butler ${view} view is not built yet. Run <code>pnpm --filter ./server/ui build</code>.</p></body></html>`;

const cache = new Map<string, { mtimeMs: number; html: string }>();

/** Read a built view (cached by mtime). Falls back to a placeholder page when the UI isn't built. */
export function loadViewHtml(view: ViewName, distDir: string = DEFAULT_UI_DIST): { html: string; built: boolean } {
  const file = join(distDir, `${view}.html`);
  if (!existsSync(file)) return { html: PLACEHOLDER(view), built: false };
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return { html: hit.html, built: true };
  const html = readFileSync(file, "utf8");
  cache.set(file, { mtimeMs, html });
  return { html, built: true };
}
