// Types only (erased at build): the zod runtime stays out of the view bundles.
import type { Decision, DecisionOption, Need, Plan, Receipt, Rule } from "@butler/contracts";

export type { Decision, DecisionOption, Need, Plan, Receipt, Rule };

export interface Envelope {
  ok?: boolean;
  spoken_summary?: string;
  error?: { code: string; message_spoken: string; candidates?: Array<{ id: string; label: string }> };
}

export type Data = Record<string, unknown> & Envelope;

export type CallOutcome<T = Data> =
  | { ok: true; data: T; spoken: string }
  | { ok: false; message: string; code?: string };

/** What a view can do against the host and the Butler server. */
export interface HostApi {
  call<T = Data>(name: string, args?: Record<string, unknown>): Promise<CallOutcome<T>>;
  /** Ask the host for fullscreen; resolves to the display mode actually granted. */
  requestFullscreen(): Promise<"inline" | "fullscreen" | "pip">;
  /** Ask the model/customer something on the view's behalf (best effort). */
  ask(text: string): Promise<void>;
  displayMode: "inline" | "fullscreen" | "pip";
  timeZone?: string;
  locale?: string;
}

export interface ViewProps<D = Data> {
  data: D | null;
  /** Error envelope message when the tool result was an error. */
  error?: string | undefined;
  host: HostApi;
}
