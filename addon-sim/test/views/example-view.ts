/** Dedicated view for the example MCP Apps server: counter button -> tool call, fullscreen request, slow carousel. */
import { App } from "@modelcontextprotocol/ext-apps";

type Obj = Record<string, unknown>;
const app = new App({ name: "example-view", version: "0.1.0" }, {}, { autoResize: true });
const root = document.getElementById("root")!;
let mode = "inline";
let state: Obj = {};

const css = `body{margin:0;font:22px/1.4 system-ui,sans-serif;background:#111827;color:#f3f4f6}.w{padding:20px}
h1{font-size:36px;margin:0 0 8px}button{font:inherit;border:0;border-radius:12px;padding:10px 18px;background:#34d399;color:#052e1b;margin:8px 8px 0 0;cursor:pointer}
.row{display:flex;gap:12px}.card{background:#1f2937;border-radius:14px;padding:14px;flex:1}small{color:#9ca3af}`;

function render(): void {
  const items = state.items as Obj[] | undefined;
  root.innerHTML = `<style>${css}</style><div class="w" data-testid="view" data-mode="${mode}">
    <h1>${String(state.title ?? "Example view")}</h1>
    ${typeof state.count === "number" ? `<div>Count: <b data-testid="count">${state.count}</b></div>` : ""}
    ${items ? `<div class="row" data-testid="carousel">${items.map((i) => `<div class="card"><b>${String(i.name)}</b><br><small>${String(i.note ?? "")}</small></div>`).join("")}</div>` : ""}
    <button data-act="inc">Increment</button><button data-act="fs">${mode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"}</button>
    <div><small data-testid="status">${String(state._status ?? "")}</small></div></div>`;
}

root.addEventListener("click", async (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (act === "inc") {
    const r = await app.callServerTool({ name: "increment", arguments: { by: 1 } });
    const sc = (r.structuredContent ?? {}) as Obj;
    state = { ...state, count: sc.count, _status: `increment -> ${String(sc.count)}` };
    render();
  } else if (act === "fs") {
    const r = await app.requestDisplayMode({ mode: mode === "fullscreen" ? "inline" : "fullscreen" });
    mode = r.mode;
    state._status = `display mode ${r.mode}`;
    render();
  }
});

app.ontoolresult = (r) => {
  const sc = (r.structuredContent ?? {}) as Obj;
  const delay = typeof sc.delay_ms === "number" ? sc.delay_ms : 0;
  setTimeout(() => {
    state = { ...sc };
    render();
  }, delay);
};
app.onhostcontextchanged = (c) => {
  const ctx = c as Obj;
  if (typeof ctx.displayMode === "string") {
    mode = ctx.displayMode;
    render();
  }
};
app.onteardown = async () => ({});
void app.connect().then(() => {
  const ctx = app.getHostContext() as Obj | undefined;
  if (typeof ctx?.displayMode === "string") mode = ctx.displayMode;
  render();
});
