import type { Brain, BrainContext, Conversation } from "../brain/types";
import { newConversation } from "../brain/session";
import { isModelVisible } from "../mcp/tools";
import type { McpClientManager } from "../mcp/client-manager";
import type { CallRecord, ElicitationHandler, ElicitationRequestInfo, ElicitationResponse, JsonSchema } from "../mcp/types";
import type { Driver, TurnOutcome } from "./runner";

/** Answer elicitation requests without a human: accept with defaults (first enum value, `true`) or decline. */
export function autoElicit(policy: "accept-defaults" | "decline"): ElicitationHandler {
  return async (req: ElicitationRequestInfo): Promise<ElicitationResponse> => {
    if (policy === "decline") return { action: "decline" };
    if (req.mode === "url") return { action: "accept" };
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [k, p] of Object.entries((req.requestedSchema?.properties ?? {}) as Record<string, JsonSchema>)) {
      if (p.default !== undefined) content[k] = p.default as string | number | boolean;
      else if (Array.isArray(p.enum) && p.enum.length) content[k] = p.enum[0] as string;
      else if (p.type === "boolean") content[k] = true;
      else if (p.type === "number" || p.type === "integer") content[k] = 0;
      else content[k] = "";
    }
    return { action: "accept", content };
  };
}

export function brainContext(manager: McpClientManager): BrainContext {
  return {
    tools: manager
      .allTools()
      .filter(isModelVisible)
      .map((t) => ({ server: t.server, name: t.name, description: t.description, inputSchema: t.inputSchema })),
    servers: manager.list().filter((c) => c.status === "connected").map((c) => ({ id: c.id, name: c.name })),
    callTool: (server, tool, args) => manager.callTool(server, tool, args, { origin: "script" }),
  };
}

/** Headless driver: brain + MCP client talk directly, no browser. */
export class LocalDriver implements Driver {
  readonly conv: Conversation = newConversation("script");
  device = "display-15";
  constructor(
    readonly manager: McpClientManager,
    readonly brain: Brain,
    readonly defaultServer: string,
    private readonly invocationNames: Record<string, string | undefined> = {},
  ) {}

  async say(utterance: string): Promise<TurnOutcome> {
    const ctx = brainContext(this.manager);
    ctx.servers = ctx.servers.map((s) => ({ ...s, invocationName: this.invocationNames[s.id] }));
    const turn = await this.brain.turn(this.conv, utterance, ctx);
    return { spoken: turn.spoken, calls: turn.calls, routing: turn.routing };
  }
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<CallRecord> {
    return this.manager.callTool(server, tool, args, { origin: "script" });
  }
  setDevice(device: string): void {
    this.device = device;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
