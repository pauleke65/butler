/** createServer(deps): registers the tools and the six ui:// views on a fresh McpServer (ticket M-1). */
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Deps } from "./deps.js";
import { serverIcon } from "./lib/icons.js";
import { loadViewHtml, VIEW_INFO, VIEW_NAMES, VIEW_URI } from "./lib/views.js";
import { TOOLS } from "./tools/index.js";
import { toolDefinition, type ToolContext } from "./tools/spec.js";

export const SERVER_NAME = "butler";
export const SERVER_VERSION = "0.1.0";

export interface RequestContext {
  householdId: string;
  /** Optional caller-supplied correlation id (x-correlation-id); a fresh one is generated per call otherwise. */
  correlationId?: string | undefined;
}

const INSTRUCTIONS =
  "Butler acts for one household. Use handle_situation when the customer describes something coming up, get_status to report progress, " +
  "answer_decision for the customer's choice on a pending question, list_actions and explain_action for receipts, " +
  "object_to_action to turn a correction into a rule (call again with confirm true after the customer says yes), " +
  "list_rules and change_rule for rules, and undo_action to reverse something. Speak from structuredContent.spoken_summary.";

/** SDK-level input is permissive: the central runner validates with the contracts schemas so errors come back as envelopes. */
const LENIENT_INPUT = z.looseObject({});

export function createServer(deps: Deps, req: RequestContext): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Butler",
      description: "Handles situations at home, shows its receipts, and turns corrections into rules it can't break.",
      icons: [serverIcon()],
    },
    { instructions: INSTRUCTIONS },
  );

  for (const spec of TOOLS) {
    const def = toolDefinition(spec);
    registerAppTool(
      server,
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: LENIENT_INPUT,
        outputSchema: spec.output as z.ZodObject,
        annotations: spec.annotations,
        _meta: (def._meta ?? { ui: {} }) as { ui: Record<string, unknown> } & Record<string, unknown>,
      },
      async (args): Promise<CallToolResult> => {
        const ctx: ToolContext = {
          deps,
          householdId: req.householdId,
          correlationId: req.correlationId ?? deps.newId("cor"),
          log: deps.logger,
        };
        return spec.run(args, ctx);
      },
    );
  }

  // Own tools/list: adds icons, field descriptions and `_meta.ui` that McpServer's default listing drops.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map(toolDefinition) }));

  for (const view of VIEW_NAMES) {
    const uri = VIEW_URI[view];
    const meta = { ui: { prefersBorder: false } };
    registerAppResource(
      server,
      VIEW_INFO[view].title,
      uri,
      { description: VIEW_INFO[view].description, mimeType: RESOURCE_MIME_TYPE, _meta: meta },
      async () => {
        const { html, built } = loadViewHtml(view, deps.config.uiDistDir);
        if (!built) deps.logger.log("warn", "views.not_built", { view });
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: meta }] };
      },
    );
  }

  return server;
}
