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
  const theme = ctx.theme ?? "dark"; // dark is the default for far-field
  document.documentElement.dataset["theme"] = theme;
  const insets = ctx.safeAreaInsets;
  if (insets) document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  // width-driven scale: Echo Show 15 (1920 px) gets 1.25x
  document.documentElement.style.setProperty("--u", window.innerWidth >= 1600 ? "1.25" : "1");
}

export function startView(View: ComponentType<ViewProps>): MiniApp {
  const root = document.getElementById("app") as HTMLElement;
  applyTheme({});

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
