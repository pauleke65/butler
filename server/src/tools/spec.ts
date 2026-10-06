/**
 * Tool specification + the central runner (tickets M-1, M-21).
 *
 * Every tool is a `ToolSpec`; `defineTool` wraps its handler in the central runner which:
 *  - validates input with the contracts zod schema (failure -> INVALID_INPUT envelope the model can learn from)
 *  - maps ANY thrown value to a §14 error envelope (never throws, never returns an empty result)
 *  - validates the output against the contracts outputSchema and lints `spoken_summary` (WARN log)
 */
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES } from "@butler/contracts";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { ButlerError, formatZodIssues, invalidInput, mapError } from "../lib/errors.js";
import { errorResult, okResult } from "../lib/envelope.js";
import { iconFor } from "../lib/icons.js";
import { lintSpoken } from "../lib/lintSpoken.js";
import type { Logger } from "../lib/logger.js";
import { VIEW_URI, type ViewName } from "../lib/views.js";

export interface ToolContext {
  deps: Deps;
  householdId: string;
  correlationId: string;
  log: Logger;
}

export interface ToolOutcome<O extends z.ZodType> {
  /** Output fields beyond `ok` (which the runner adds). */
  data: Omit<z.infer<O>, "ok">;
  /** Override the default view for this call (get_status switches to options). */
  view?: ViewName;
}

export interface ToolUi {
  view: ViewName;
  invoking: string;
  invoked: string;
}

export interface ToolSpec<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
  /** Null for app-only helper tools. */
  ui: ToolUi | null;
  /** Hidden from the model; callable by views (`_meta.ui.visibility: ["app"]`). */
  appOnly?: boolean;
  /** Per-field descriptions injected into the JSON schema so a model can fill arguments correctly. */
  fieldDescriptions?: Record<string, string>;
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

export interface RegisteredToolSpec {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations: ToolAnnotations;
  ui: ToolUi | null;
  appOnly: boolean;
  fieldDescriptions: Record<string, string>;
  run(rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(spec: ToolSpec<I, O>): RegisteredToolSpec {
  const run = async (rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> => {
    const started = Date.now();
    const log = ctx.log.child({ tool: spec.name, correlation_id: ctx.correlationId, household_id: ctx.householdId });
    try {
      const parsed = spec.input.safeParse(rawArgs ?? {});
      if (!parsed.success) throw invalidInput(formatZodIssues(parsed.error));

      const outcome = await spec.handler(parsed.data, ctx);
      const body = { ok: true as const, ...(outcome.data as Record<string, unknown>) };
      const checked = spec.output.safeParse(body);
      if (!checked.success) {
        throw new ButlerError("INTERNAL", undefined, { details: `output contract violation: ${formatZodIssues(checked.error)}` });
      }
      const data = checked.data as { spoken_summary: string } & Record<string, unknown>;

      const violations = lintSpoken(data.spoken_summary);
      if (violations.length > 0) log.log("warn", "spoken.lint", { violations, spoken: data.spoken_summary });

      log.log("info", "tool.ok", { ms: Date.now() - started });
      const ui = spec.ui ? { ...spec.ui, view: outcome.view ?? spec.ui.view } : undefined;
      return okResult(data, ui);
    } catch (e) {
      const err = mapError(e);
      const level = err.code === "INTERNAL" || err.code === "UPSTREAM_UNAVAILABLE" ? "error" : "info";
      log.log(level, "tool.error", { ms: Date.now() - started, code: err.code, details: err.details });
      const violations = lintSpoken(err.messageSpoken);
      if (violations.length > 0) log.log("warn", "spoken.lint", { violations, spoken: err.messageSpoken });
      return errorResult(err);
    }
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    annotations: spec.annotations,
    ui: spec.ui,
    appOnly: spec.appOnly ?? false,
    fieldDescriptions: spec.fieldDescriptions ?? {},
    run,
  };
}

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  return z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "any" }) as JsonSchema;
}

/**
 * Error envelope (contracts §14) as JSON Schema. Strict clients (the SDK's own client included) validate any
 * structuredContent against the tool's outputSchema, even on `isError` results, so the advertised outputSchema
 * accepts either the success shape or this one.
 */
export const ERROR_OUTPUT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ok: { const: false },
    spoken_summary: { type: "string" },
    error: {
      type: "object",
      properties: {
        code: { type: "string", enum: [...ERROR_CODES] },
        message_spoken: { type: "string" },
        candidates: {
          type: "array",
          maxItems: 3,
          items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] },
        },
        details: { type: "string" },
      },
      required: ["code", "message_spoken"],
    },
  },
  required: ["ok", "spoken_summary", "error"],
};

/** The `tools/list` entry (adds icons, field descriptions and `_meta.ui`). */
export function toolDefinition(spec: RegisteredToolSpec): Tool {
  const input = toJsonSchema(spec.input, "input");
  const props = input["properties"] as Record<string, JsonSchema> | undefined;
  if (props) {
    for (const [field, description] of Object.entries(spec.fieldDescriptions)) {
      const p = props[field];
      if (p) p["description"] = description;
    }
  }
  const meta: Record<string, unknown> = {};
  if (spec.appOnly) {
    meta["ui"] = { visibility: ["app"] };
  } else if (spec.ui) {
    meta["ui"] = { resourceUri: VIEW_URI[spec.ui.view] };
    meta["ui/resourceUri"] = VIEW_URI[spec.ui.view];
  }
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: input as Tool["inputSchema"],
    outputSchema: (() => {
      const success = toJsonSchema(spec.output, "output");
      delete success["$schema"];
      return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", oneOf: [success, ERROR_OUTPUT_JSON_SCHEMA] };
    })() as NonNullable<Tool["outputSchema"]>,
    annotations: { title: spec.title, ...spec.annotations },
    icons: [iconFor(spec.name)],
    _meta: meta,
  };
}
