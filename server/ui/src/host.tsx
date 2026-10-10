/** View bootstrap: handlers are registered BEFORE connect(); first paint comes straight from ontoolresult. */
import { render, type ComponentType } from "preact";
import { MiniApp, type HostContext, type ToolResult } from "./bridge";
import type { CallOutcome, Data, HostApi, ViewProps } from "./types";

function messageOf(r: ToolResult): string | undefined {
  const sc = r.structuredContent as Data | undefined;
  return sc?.error?.message_spoken ?? sc?.spoken_summary ?? r.content?.find((c) => c.type === "text")?.text;
}

export function outcomeOf<T = Data>(r: ToolResult): CallOutcome<T> {
  const sc = (r.structuredContent ?? {}) as Data;
  if (r.isError || sc.ok === false) {
    return { ok: false, message: messageOf(r) ?? "Something went wrong.", ...(sc.error?.code ? { code: sc.error.code } : {}) };
  }
  return { ok: true, data: sc as T, spoken: sc.spoken_summary ?? "" };
}

export function applyTheme(ctx: HostContext): void {
  const root = document.documentElement;
  root.dataset["theme"] = ctx.theme ?? "dark"; // dark is the default for far-field
  root.dataset["display"] = ctx.displayMode ?? root.dataset["display"] ?? "inline";
  const insets = ctx.safeAreaInsets;
  if (insets) {
    // as variables, so fullscreen can add its own gutter on top (tokens.css)
    for (const [k, v] of [["t", insets.top], ["r", insets.right], ["b", insets.bottom], ["l", insets.left]] as const) root.style.setProperty(`--inset-${k}`, `${v ?? 0}px`);
  }
  applyScale();
}

/** Alexa+ authors on a 768-unit canvas and zooms 1.667x on Echo Show 8 and 15; narrow hosts get a smaller step. */
function applyScale(): void {
  document.documentElement.style.setProperty("--u", window.innerWidth < 560 ? "1.25" : "1.667");
}

export function startView(View: ComponentType<ViewProps>): MiniApp {
  const root = document.getElementById("app") as HTMLElement;
  applyTheme({});
  window.addEventListener("resize", applyScale);

  let data: Data | null = null;
  let error: string | undefined;
  let version = 0;
  let displayMode: HostApi["displayMode"] = "inline";
  let ctx: HostContext = {};

  const app = new MiniApp({ name: "butler-view", version: "0.1.0" });

  const host: HostApi = {
    async call(name, args = {}) {
      try {
        return outcomeOf(await app.callServerTool({ name, arguments: args }));
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "The request failed." };
      }
    },
    async requestFullscreen() {
      try {
        const mode = await app.requestDisplayMode("fullscreen");
        displayMode = mode === "fullscreen" || mode === "pip" ? mode : "inline";
      } catch {
        displayMode = "inline";
      }
      paint();
      return displayMode;
    },
    async ask(text) {
      try {
        await app.sendMessage(text);
      } catch {
        /* host may not support ui/message */
      }
    },
    get displayMode() {
      return displayMode;
    },
    get timeZone() {
      return ctx.timeZone;
    },
    get locale() {
      return ctx.locale;
    },
  };

  const paint = (): void => {
    render(<View key={version} data={data} error={error} host={host} />, root);
  };

  // 1. register handlers  2. paint the skeleton  3. connect
  app.ontoolresult = (result) => {
    const sc = result.structuredContent as Data | undefined;
    if (result.isError || sc?.ok === false) {
      error = messageOf(result) ?? "Something went wrong.";
      data = null;
    } else {
      error = undefined;
      data = sc ?? null;
    }
    version++;
    paint();
  };
  app.onhostcontextchanged = (c) => {
    ctx = { ...ctx, ...c };
    applyTheme(ctx);
    if (c.displayMode) displayMode = c.displayMode;
    paint();
  };
  app.onteardown = () => {
    app.close();
  };

  paint();
  if (app.isEmbedded) {
    app.connect().catch((e: unknown) => {
      error = e instanceof Error ? e.message : "Could not reach the host.";
      paint();
    });
  }
  return app;
}
