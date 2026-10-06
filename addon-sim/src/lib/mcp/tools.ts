import { RESOURCE_URI_META_KEY } from "./constants";
import type { ToolResult, ToolInfo } from "./types";

type Meta = Record<string, unknown> | undefined;

function uiMeta(meta: Meta): { resourceUri?: string; visibility?: Array<"model" | "app"> } | undefined {
  const ui = meta?.ui;
  return ui && typeof ui === "object" ? (ui as { resourceUri?: string; visibility?: Array<"model" | "app"> }) : undefined;
}

/** `_meta.ui.resourceUri`, or the legacy flat `_meta["ui/resourceUri"]` key. */
export function getUiResourceUri(meta: Meta): string | undefined {
  const nested = uiMeta(meta)?.resourceUri;
  if (typeof nested === "string") return nested;
  const flat = meta?.[RESOURCE_URI_META_KEY];
  return typeof flat === "string" ? flat : undefined;
}

export function getVisibility(meta: Meta): Array<"model" | "app"> | undefined {
  const v = uiMeta(meta)?.visibility;
  return Array.isArray(v) ? v : undefined;
}

/** A tool is shown to the model unless its UI visibility excludes "model" (e.g. ["app"] only). */
export function isModelVisible(tool: Pick<ToolInfo, "visibility">): boolean {
  return !tool.visibility || tool.visibility.includes("model");
}

/** Result-level `_meta.ui.resourceUri` wins over the tool definition (Alexa+ puts it on the result). */
export function resolveUiResourceUri(tool: ToolInfo | undefined, result: ToolResult | undefined): string | undefined {
  return getUiResourceUri(result?._meta) ?? tool?.uiResourceUri;
}

export function resultText(result: ToolResult | undefined): string {
  if (!result) return "";
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** Short human line from a tool result: spoken_summary > error.message_spoken > first text block. */
export function spokenFromResult(result: ToolResult | undefined): string {
  const sc = result?.structuredContent as Record<string, unknown> | undefined;
  if (typeof sc?.spoken_summary === "string" && sc.spoken_summary.trim()) return sc.spoken_summary.trim();
  const err = sc?.error as Record<string, unknown> | undefined;
  if (typeof err?.message_spoken === "string") return err.message_spoken;
  const text = resultText(result).trim();
  if (text) {
    // Avoid reading JSON aloud.
    if (/^[\[{]/.test(text)) return result?.isError ? "Something went wrong with that request." : "Done.";
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
  }
  return result?.isError ? "Something went wrong with that request." : "Done.";
}
