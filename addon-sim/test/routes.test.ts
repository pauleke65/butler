import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as proxyGET } from "../src/app/api/proxy/route";
import { POST as ttsPOST } from "../src/app/api/tts/route";
import { GET as configGET } from "../src/app/api/config/route";
import { GET as scriptsGET } from "../src/app/api/scripts/route";

let origin = "";
const http = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ auth: req.headers.authorization ?? null }));
});
beforeAll(async () => {
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => http.close(() => r())));

describe("API routes", () => {
  it("/api/tts tells the browser to fall back when not in bedrock mode", async () => {
    delete process.env.LLM_MODE;
    const res = await ttsPOST(new Request("http://x/api/tts", { method: "POST", body: JSON.stringify({ text: "hi" }) }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { fallback: boolean }).fallback).toBe(true);
  });

  it("/api/proxy only reaches allow-listed origins and forwards the Authorization header", async () => {
    const url = (u: string) => `http://x/api/proxy?url=${encodeURIComponent(u)}`;
    expect((await proxyGET(new Request(url(`${origin}/rules`)))).status).toBe(403);
    process.env.PANEL_PROXY_ALLOW = origin;
    const ok = await proxyGET(new Request(url(`${origin}/rules`), { headers: { "x-proxy-authorization": "Bearer abc" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ auth: "Bearer abc" });
    expect((await proxyGET(new Request("http://x/api/proxy"))).status).toBe(400);
    expect((await proxyGET(new Request(url("http://169.254.169.254/latest/meta-data")))).status).toBe(403);
    delete process.env.PANEL_PROXY_ALLOW;
  });

  it("/api/config exposes defaults without leaking unrelated env", async () => {
    process.env.PANEL_URLS = "http://localhost:3002/panel.js";
    process.env.AWS_SECRET_ACCESS_KEY = "super-secret";
    const body = JSON.stringify(await (await configGET()).json());
    expect(body).toContain("http://localhost:3002/panel.js");
    expect(body).toContain("local-sim-token"); // documented local default token
    expect(body).not.toContain("super-secret");
    delete process.env.PANEL_URLS;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it("/api/scripts lists the shipped scripts and rejects path traversal", async () => {
    const list = (await (await scriptsGET(new Request("http://x/api/scripts"))).json()) as { scripts: string[] };
    expect(list.scripts).toContain("butler-golden.yaml");
    expect((await scriptsGET(new Request("http://x/api/scripts?name=../package.json"))).status).toBe(400);
    const one = (await (await scriptsGET(new Request("http://x/api/scripts?name=butler-golden.yaml"))).json()) as { yaml: string };
    expect(one.yaml).toContain("Butler golden demo");
  });
});
