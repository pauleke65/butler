/**
 * One view, hosted for real: the ext-apps AppBridge (host side) talks to the built single-file view over
 * postMessage, and answers the view's tools/call with the real Butler server (fixture server on :8001).
 *   frame.html?s=<scenario>&device=show8|show15&theme=dark|light&fit=1&bare=1
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEVICES, SCENARIOS, type DeviceId } from "./scenarios";

const SERVER = (import.meta.env?.["VITE_BUTLER_URL"] as string | undefined) ?? "http://127.0.0.1:8001";
const q = new URLSearchParams(location.search);
const scenario = SCENARIOS.find((s) => s.id === q.get("s")) ?? SCENARIOS[0]!;
const device = DEVICES[(q.get("device") as DeviceId) ?? "show8"] ?? DEVICES.show8;
const theme: "light" | "dark" = q.get("theme") === "light" ? "light" : "dark";
if (q.get("bare")) document.body.classList.add("bare");
// the host canvas behind the (transparent) inline view
document.body.style.background = theme === "light" ? "#f3f5f9" : "#173055";
document.documentElement.style.colorScheme = theme;

const iframe = document.getElementById("view") as HTMLIFrameElement;
const stage = document.getElementById("stage") as HTMLElement;
const bar = document.getElementById("bar") as HTMLElement;
// The Alexa+ conversation layout gives an add-on view the space right of the reply bubble: the screen minus
// 296 canvas units (x1.667) of margins and bubble. Fullscreen gets the whole screen.
const INLINE_W = device.width - Math.round(296 * 1.667);
const setFrame = (mode: "inline" | "fullscreen"): void => {
  iframe.width = String(mode === "fullscreen" ? device.width : INLINE_W);
  iframe.height = String(device.height);
  document.body.dataset["mode"] = mode;
};
setFrame("inline");

const fit = (): void => {
  if (!q.get("fit")) return;
  const s = Math.min(window.innerWidth / device.width, (window.innerHeight - 30) / device.height, 1);
  stage.style.transform = `scale(${s})`;
};
window.addEventListener("resize", fit);
fit();

async function main(): Promise<void> {
  await fetch(`${SERVER}/__fixtures/reset`);
  const ids = (await (await fetch(`${SERVER}/__fixtures/ids`)).json()) as Record<string, string>;
  const sub = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$ids.")) return ids[v.slice(5)];
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };

  const client = new Client({ name: "butler-preview", version: "0.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`)));
  await client.listTools();

  let result: Awaited<ReturnType<Client["callTool"]>> | undefined;
  for (const step of scenario.steps) result = await client.callTool({ name: step.tool, arguments: sub(step.args) as Record<string, unknown> });
  if (!result) throw new Error("scenario produced no result");

  const hostContext = {
    theme,
    displayMode: "inline" as "inline" | "fullscreen",
    availableDisplayModes: ["inline", "fullscreen"] as Array<"inline" | "fullscreen">,
    platform: "web" as const,
    timeZone: "America/New_York",
    locale: "en-US",
    containerDimensions: { width: device.width, maxHeight: device.height },
  };
  const bridge = new AppBridge(client, { name: "butler-preview-host", version: "0.0.0" }, { serverTools: {}, openLinks: {} }, { hostContext });

  let reported = 0;
  const updateBar = (note = ""): void => {
    bar.innerHTML = `<b>${scenario.title}</b> <span>${device.label} ${device.width}x${device.height}</span> <span>view reports ${reported}px tall</span> <span>${note}</span>`;
  };
  updateBar();

  bridge.onsizechange = ({ height }) => {
    if (typeof height === "number") reported = Math.round(height);
    updateBar();
  };
  bridge.oncalltool = async (params) => (await client.callTool(params)) as never;
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const granted = mode === "pip" ? "inline" : mode;
    hostContext.displayMode = granted;
    setFrame(granted);
    bridge.setHostContext(hostContext);
    await bridge.sendHostContextChange({ displayMode: granted });
    updateBar(`display mode: ${granted}`);
    return { mode: granted };
  };
  bridge.onmessage = async (p) => {
    updateBar(`view sent a message: ${JSON.stringify(p.content?.[0] && "text" in p.content[0] ? p.content[0].text : "")}`);
    return {};
  };
  bridge.oninitialized = async () => {
    // first paint straight from the tool result, no extra fetch (contracts §4)
    await bridge.sendToolResult(result as Parameters<typeof bridge.sendToolResult>[0]);
    const click = q.get("click");
    if (click) {
      // scripted interaction for screenshots, e.g. click=See%20more
      await new Promise((r) => setTimeout(r, 700));
      const doc = iframe.contentDocument;
      [...(doc?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === click)?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    document.title = `ready: ${scenario.id}`;
    document.body.dataset["ready"] = "1";
  };

  const html = await (await fetch(`/views/${scenario.view}.html`)).text();
  await bridge.connect(new PostMessageTransport(iframe.contentWindow as Window, iframe.contentWindow as Window));
  iframe.srcdoc = html;
}

main().catch((e: unknown) => {
  bar.textContent = `preview failed: ${e instanceof Error ? e.message : String(e)}`;
  document.body.dataset["ready"] = "error";
});
