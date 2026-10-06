/**
 * Sandbox proxy server (default :3001). Serves ONLY sandbox.html (+ its script) so MCP App views run on a
 * different origin than the host (:3000), as the MCP Apps spec requires for web hosts. The CSP for each view
 * is derived from the `?csp=` query param and sent as an HTTP header (tamper-proof, unlike a meta tag).
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCspHeader, type UiCsp } from "../src/lib/apps-host/csp";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SANDBOX_PORT ?? 3001);
const allowedHost = process.env.SANDBOX_ALLOWED_HOST; // e.g. "http://my-dev-box:3000" (localhost is always allowed)
const html = () =>
  readFileSync(join(here, "public", "sandbox.html"), "utf8").replace(
    "<!--ALLOWED_HOST-->",
    allowedHost && /^https?:\/\/[\w.-]+(:\d+)?$/.test(allowedHost) ? `<meta name="allowed-host" content="${allowedHost}" />` : "",
  );
const js = () => readFileSync(join(here, "public", "sandbox.js"));

export function handle(url: URL): { status: number; headers: Record<string, string>; body: string | Buffer } {
  if (url.pathname === "/" || url.pathname === "/sandbox.html") {
    let csp: UiCsp | undefined;
    const raw = url.searchParams.get("csp");
    if (raw) {
      try {
        csp = JSON.parse(raw) as UiCsp;
      } catch {
        /* invalid CSP param: fall back to the restrictive default */
      }
    }
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": buildCspHeader(csp),
        "cache-control": "no-store",
      },
      body: html(),
    };
  }
  if (url.pathname === "/sandbox.js") {
    return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }, body: js() };
  }
  if (url.pathname === "/healthz") return { status: 200, headers: { "content-type": "text/plain" }, body: "ok" };
  return { status: 404, headers: { "content-type": "text/plain" }, body: "Only the sandbox proxy is served on this port" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer((req, res) => {
    const r = handle(new URL(req.url ?? "/", "http://localhost"));
    res.writeHead(r.status, r.headers).end(r.body);
  }).listen(port, () => console.log(`sandbox proxy: http://localhost:${port}/sandbox.html`));
}
