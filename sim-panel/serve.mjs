// Serves dist/ (the built panel module) with CORS so addon-sim can `import()` it from another origin.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PANEL_PORT ?? 3002);
createServer(async (req, res) => {
  const name = (req.url ?? "/").split("?")[0].replace(/^\/+/, "") || "panel.js";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    const body = await readFile(join(root, name));
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404, { "access-control-allow-origin": "*" }).end("not found (run `pnpm build` first)");
  }
}).listen(port, () => console.log(`panel module: http://localhost:${port}/panel.js`));
