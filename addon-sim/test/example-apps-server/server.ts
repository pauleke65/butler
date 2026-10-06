/**
 * Tiny MCP Apps server in the shape of the public ext-apps examples: tools declare `_meta.ui.resourceUri`
 * on the definition only, results carry plain text + structuredContent without a `spoken_summary`.
 * Exercises: view -> tools/call, fullscreen request, slow carousel (render-time warning), elicitation (form + url).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { buildViewHtml } from "../support/view-bundle";

const here = dirname(fileURLToPath(import.meta.url));
const viewEntry = join(here, "..", "views", "example-view.ts");

export interface ExampleState {
  count: number;
}

export function createExampleServer(state: ExampleState = { count: 0 }): McpServer {
  const server = new McpServer({ name: "example-apps", version: "0.1.0" });
  const counterUri = "ui://example/counter";
  const carouselUri = "ui://example/slow-carousel";

  for (const [name, uri] of [["counter-view", counterUri], ["carousel-view", carouselUri]] as const) {
    registerAppResource(server, name, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await buildViewHtml(viewEntry) }],
    }));
  }

  registerAppTool(
    server,
    "show_counter",
    {
      title: "Show counter",
      description: "Show a counter widget. Use when someone asks to see the counter, count something, or try the example app.",
      inputSchema: {},
      _meta: { ui: { resourceUri: counterUri } },
    },
    async () => ({ content: [{ type: "text", text: `The counter is at ${state.count}.` }], structuredContent: { title: "Counter", count: state.count } }),
  );

  registerAppTool(
    server,
    "increment",
    {
      title: "Increment",
      description: "Increase the counter (called by the counter view).",
      inputSchema: { by: z.number().default(1) },
      _meta: { ui: { resourceUri: counterUri, visibility: ["app"] } },
    },
    async ({ by }) => {
      state.count += by;
      return { content: [{ type: "text", text: `Counter is now ${state.count}.` }], structuredContent: { count: state.count } };
    },
  );

  registerAppTool(
    server,
    "show_slow_carousel",
    {
      title: "Show slow carousel",
      description: "Show a carousel of options whose view renders slowly (used to test the 500 ms first-render budget). Use when someone asks for the slow carousel or the gallery.",
      inputSchema: { delay_ms: z.number().default(800) },
      _meta: { ui: { resourceUri: carouselUri } },
    },
    async ({ delay_ms }) => ({
      content: [{ type: "text", text: "Here are three options." }],
      structuredContent: { title: "Options", delay_ms, items: [{ name: "Alpha", note: "fast" }, { name: "Beta", note: "balanced" }, { name: "Gamma", note: "thorough" }] },
    }),
  );

  registerAppTool(
    server,
    "buy_coffee",
    {
      title: "Buy coffee",
      description: "Buy a coffee for the customer. Use when someone asks to order or buy a coffee. Asks the customer to confirm first.",
      inputSchema: {},
      _meta: {},
    },
    async (_args, extra) => {
      // relatedRequestId keeps the elicitation on the tools/call response stream (works behind proxies / stateless-ish hosts).
      const res = await server.server.elicitInput({
        mode: "form",
        message: "Should I order a coffee for 4 dollars?",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string", title: "Order it?", enum: ["Yes, order it", "No"], default: "Yes, order it" } },
          required: ["answer"],
        },
      }, { relatedRequestId: extra.requestId });
      const yes = res.action === "accept" && String((res.content as { answer?: string } | undefined)?.answer).startsWith("Yes");
      return { content: [{ type: "text", text: yes ? "Ordered one coffee for 4 dollars." : "Okay, no coffee." }], structuredContent: { ordered: yes, spoken_summary: yes ? "Ordered one coffee for 4 dollars." : "Okay, no coffee." } };
    },
  );

  registerAppTool(
    server,
    "pay_online",
    {
      title: "Pay online",
      description: "Pay an invoice online. Use when someone asks to pay the invoice. Sends the customer to a secure approval page.",
      inputSchema: {},
      _meta: {},
    },
    async (_args, extra) => {
      const res = await server.server.elicitInput({
        mode: "url",
        message: "Please approve the 12 dollar invoice on the secure page.",
        url: "https://example.com/approve?invoice=demo",
        elicitationId: "elic-demo-1",
      }, { relatedRequestId: extra.requestId });
      return { content: [{ type: "text", text: res.action === "accept" ? "Thanks, approval started." : "Okay, I didn't start the payment." }], structuredContent: { action: res.action } };
    },
  );

  return server;
}
