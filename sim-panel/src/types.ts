/** Panel plugin contract of addon-sim (copied; the plugin has no runtime dependency on addon-sim). */
export interface PanelSimEvent {
  type: "call_start" | "call_end" | "utterance" | "reply" | "device" | "reset";
  at: number;
  tool?: string;
  server?: string;
  text?: string;
}
export interface PanelCtx {
  sessionId: string;
  env: Record<string, string>;
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response>;
  onEvent(cb: (e: PanelSimEvent) => void): () => void;
  theme: "dark";
}
export interface Panel {
  id: string;
  title: string;
  mount(el: HTMLElement, ctx: PanelCtx): void | (() => void) | Promise<void | (() => void)>;
}

/** The slice of the Butler contracts (section 2) that the panel reads from the debug API (section 11). */
export interface DebugReceipt {
  action_id: string;
  title: string;
  status: "executed" | "held_for_approval" | "blocked" | "failed" | "undone";
  action: { tool: string; args: Record<string, unknown> };
  authority: {
    decision: "ALLOW" | "DENY";
    principal: string;
    rule_ids: string[];
    rule_texts: string[];
    matcher_gateway_agree?: boolean;
  };
  cost?: { amount_minor: number; currency: string };
  created_at: string;
  simulated?: boolean;
}

export interface DebugRule {
  rule_id: string;
  text: string;
  effect: "allow" | "ask_first" | "never";
  template?: string;
  policy_status: "draft" | "creating" | "active" | "failed" | "disabled";
  active: boolean;
  created_at: string;
  updated_at?: string;
  origin?: { type: "default" } | { type: "correction"; utterance?: string };
}
