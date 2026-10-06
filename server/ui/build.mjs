// Builds one self-contained HTML file per view (dist/<view>.html).
// vite-plugin-singlefile can't inline several entries in one build, so each view is its own Vite build.
import { build } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const VIEWS = ["plan", "options", "receipt", "actions", "rule", "rules"];
const LIMIT = 200 * 1024;

const only = process.argv.slice(2);
const views = only.length ? only : VIEWS;
if (!only.length) rmSync(resolve(root, "dist"), { recursive: true, force: true });

let failed = false;
for (const view of views) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [preact(), viteSingleFile({ removeViteModuleLoader: true })],
    resolve: { alias: { "@": resolve(root, "src") } },
    build: {
      outDir: "dist",
      emptyOutDir: false,
      target: "es2022",
      minify: "esbuild",
      cssMinify: true,
      assetsInlineLimit: 100_000_000,
      rollupOptions: { input: resolve(root, `${view}.html`) },
    },
  });
  const file = resolve(root, "dist", `${view}.html`);
  const size = statSync(file).size;
  const ok = size < LIMIT;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "BIG "} ${view}.html ${(size / 1024).toFixed(1)} KB`);
  void readFileSync;
}
if (failed) {
  console.error(`A view exceeds ${LIMIT / 1024} KB`);
  process.exit(1);
}
