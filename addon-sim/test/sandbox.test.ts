import { describe, expect, it } from "vitest";
import { buildCspHeader, sandboxUrl, sanitizeDomains } from "../src/lib/apps-host/csp";
import { handle } from "../sandbox/server";

describe("CSP builder", () => {
  it("is restrictive by default", () => {
    const csp = buildCspHeader();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
  it("enforces declared domains and drops injection attempts", () => {
    const csp = buildCspHeader({ connectDomains: ["https://api.example.com", "x.com; script-src *"], resourceDomains: ["https://cdn.example.com"], frameDomains: ["https://embed.example.com"] });
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).not.toContain("script-src *");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.example.com");
    expect(csp).toContain("frame-src https://embed.example.com");
    expect(sanitizeDomains(["a b", "ok.com", "it's.com"])).toEqual(["ok.com"]);
  });
  it("puts csp in the sandbox URL only when declared", () => {
    expect(sandboxUrl("http://localhost:3001")).toBe("http://localhost:3001/sandbox.html");
    expect(sandboxUrl("http://localhost:3001", { connectDomains: ["https://a.com"] })).toContain("csp=%7B");
  });
});

describe("sandbox server", () => {
  it("serves the proxy with a CSP header derived from the query and nothing else", () => {
    const csp = encodeURIComponent(JSON.stringify({ connectDomains: ["https://api.example.com"] }));
    const r = handle(new URL(`http://localhost:3001/sandbox.html?csp=${csp}`));
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toContain("connect-src 'self' https://api.example.com");
    expect(String(r.body)).toContain("/sandbox.js");
    expect(handle(new URL("http://localhost:3001/sandbox.js")).status).toBe(200);
    expect(handle(new URL("http://localhost:3001/api/mcp/call")).status).toBe(404);
    expect(handle(new URL("http://localhost:3001/package.json")).status).toBe(404);
  });
  it("ignores a malformed csp param", () => {
    const r = handle(new URL("http://localhost:3001/sandbox.html?csp=%7Bbroken"));
    expect(r.headers["content-security-policy"]).toContain("connect-src 'none'");
  });
});
