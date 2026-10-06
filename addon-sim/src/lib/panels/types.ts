/**
 * Panel plugin API. A panel is an ES module whose default export (or `panel` / `panels` export) matches `Panel`.
 * Panels are loaded by URL (PANEL_URLS) so add-on specific UI (e.g. a debug feed) stays out of the simulator.
 * This file is the contract; copy these types into your plugin (no runtime import needed).
 */
export interface PanelSimEvent {
  type: "call_start" | "call_end" | "utterance" | "reply" | "device" | "reset";
  at: number;
  /** tool name for call_* events */
  tool?: string;
  server?: string;
  text?: string;
}

export interface PanelCtx {
  /** Conversation session id of the simulator page. */
  sessionId: string;
  /** Whitelisted environment: DEBUG_API_URL, DEBUG_API_TOKEN and any PANEL_ENV_* variable (prefix stripped). */
  env: Record<string, string>;
  /** fetch() that goes through the simulator's allow-listed same-origin proxy (no CORS problems). Header names are preserved; `Authorization` is forwarded. */
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response>;
  /** Subscribe to simulator events (tool calls, utterances). Returns an unsubscribe function. */
  onEvent(cb: (e: PanelSimEvent) => void): () => void;
  theme: "dark";
}

export interface Panel {
  /** Unique, stable id. */
  id: string;
  title: string;
  /** Render into `el`. May return a cleanup function (sync or async). */
  mount(el: HTMLElement, ctx: PanelCtx): void | (() => void) | Promise<void | (() => void)>;
}
