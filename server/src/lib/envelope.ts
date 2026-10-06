/** Response envelope (contracts §3.1) and error envelope (§14). */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ButlerError, Candidate } from "./errors.js";
import { VIEW_URI, type ViewName } from "./views.js";

export interface UiHint {
  view: ViewName;
  invoking: string;
  invoked: string;
}

export type OkData = { spoken_summary: string } & Record<string, unknown>;

export function okResult(structured: OkData, ui?: UiHint): CallToolResult {
  const structuredContent = { ok: true, ...structured };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    ...(ui ? { _meta: { ui: { resourceUri: VIEW_URI[ui.view], invoking: ui.invoking, invoked: ui.invoked } } } : {}),
  };
}

export interface ErrorBody {
  code: string;
  message_spoken: string;
  candidates?: Candidate[];
  /** Additive, for the calling model to self-correct (not spoken). */
  details?: string;
}

export function errorResult(e: ButlerError): CallToolResult {
  const error: ErrorBody = {
    code: e.code,
    message_spoken: e.messageSpoken,
    ...(e.candidates && e.candidates.length > 0 ? { candidates: e.candidates.slice(0, 3) } : {}),
    ...(e.details ? { details: e.details.slice(0, 400) } : {}),
  };
  // `spoken_summary` mirrors message_spoken so a host that only reads that field still speaks something.
  const structuredContent = { ok: false, spoken_summary: e.messageSpoken, error };
  return {
    isError: true,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}
