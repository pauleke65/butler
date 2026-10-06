// Dev server for the fixture preview: serves preview/*.html and the built single-file views at /views/<view>.html.
import { defineConfig, type Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const serveBuiltViews = (): Plugin => ({
  name: "serve-built-views",
  configureServer(server) {
    server.middlewares.use("/views", (req, res, next) => {
      const name = (req.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
      const file = resolve(root, "dist", name);
      if (!/^[a-z]+\.html$/.test(name) || !existsSync(file)) return next();
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(readFileSync(file));
    });
  },
});

export default defineConfig({
  root: resolve(root, "preview"),
  plugins: [serveBuiltViews()],
  server: { fs: { allow: [resolve(root, "../..")] } },
  optimizeDeps: { include: ["@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/client/streamableHttp.js"] },
});
