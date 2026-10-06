/** CSP for the sandbox proxy, built from a view's `_meta.ui.csp` (MCP Apps spec 2026-01-26, "Sandbox proxy"). */

export interface UiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** Reject entries that could break out of a directive (`;`, newlines, quotes, spaces). */
export function sanitizeDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.filter((d): d is string => typeof d === "string" && d.length > 0 && !/[;\r\n'" ]/.test(d));
}

export function buildCspHeader(csp?: UiCsp | null): string {
  const resource = sanitizeDomains(csp?.resourceDomains).join(" ");
  const connect = sanitizeDomains(csp?.connectDomains).join(" ");
  const frame = sanitizeDomains(csp?.frameDomains).join(" ");
  const base = sanitizeDomains(csp?.baseUriDomains).join(" ");
  const j = (...parts: string[]) => parts.filter(Boolean).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    j("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:", resource),
    j("style-src 'self' 'unsafe-inline' blob: data:", resource),
    j("img-src 'self' data: blob:", resource),
    j("font-src 'self' data: blob:", resource),
    j("media-src 'self' data: blob:", resource),
    connect ? `connect-src 'self' ${connect}` : "connect-src 'none'",
    j("worker-src 'self' blob:", resource),
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "object-src 'none'",
    base ? `base-uri ${base}` : "base-uri 'none'",
  ].join("; ");
}

/** The sandbox proxy page URL for a view (CSP travels in the query so the sandbox server can send it as a header). */
export function sandboxUrl(origin: string, csp?: UiCsp | null): string {
  const u = new URL("/sandbox.html", origin);
  if (csp && Object.keys(csp).length) u.searchParams.set("csp", JSON.stringify(csp));
  return u.href;
}
