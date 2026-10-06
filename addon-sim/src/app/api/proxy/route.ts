export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin fetch proxy for panel plugins (so panels can reach local APIs without CORS).
 * Only origins listed in PANEL_PROXY_ALLOW (plus DEBUG_API_URL) are reachable; GET only.
 */
function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  for (const v of [...(process.env.PANEL_PROXY_ALLOW ?? "").split(","), process.env.DEBUG_API_URL ?? "http://localhost:8085"]) {
    try {
      if (v.trim()) out.add(new URL(v.trim()).origin);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return Response.json({ error: "url required" }, { status: 400 });
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return Response.json({ error: "bad url" }, { status: 400 });
  }
  if (!allowedOrigins().has(u.origin)) return Response.json({ error: `origin ${u.origin} is not allowed (set PANEL_PROXY_ALLOW)` }, { status: 403 });
  const headers: Record<string, string> = {};
  const auth = req.headers.get("x-proxy-authorization");
  if (auth) headers.authorization = auth;
  try {
    const res = await fetch(u, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
