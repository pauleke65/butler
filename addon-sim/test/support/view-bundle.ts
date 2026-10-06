import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Bundle a view entry (TS using @modelcontextprotocol/ext-apps `App`) into one self-contained HTML document. */
export async function buildViewHtml(entry = join(here, "..", "views", "view.ts")): Promise<string> {
  const hit = cache.get(entry);
  if (hit) return hit;
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    logLevel: "silent",
  });
  const js = out.outputFiles[0]!.text.replace(/<\/script>/g, "<\\/script>");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>view</title></head><body><div id="root"></div><script>${js}</script></body></html>`;
  cache.set(entry, html);
  return html;
}
