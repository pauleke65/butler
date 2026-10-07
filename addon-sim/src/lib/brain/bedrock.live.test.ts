/**
 * Live Bedrock check. Skipped unless RUN_BEDROCK_TESTS=1 (uses your real AWS credentials, a few cents of tokens).
 *   RUN_BEDROCK_TESTS=1 pnpm vitest run src/lib/brain/bedrock.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockButler, newMockState } from "../../../test/mock-server/butler-mock";
import { serveMcp, type ServedMcp } from "../../../test/support/http";
import { McpClientManager } from "../mcp/client-manager";
import { isModelVisible } from "../mcp/tools";
import { BedrockBrain } from "./bedrock";
import { newConversation } from "./session";
import type { BrainContext } from "./types";

describe.skipIf(!process.env.RUN_BEDROCK_TESTS)("BedrockBrain (live)", () => {
  let served: ServedMcp;
  const mgr = new McpClientManager();
  beforeAll(async () => {
    const state = newMockState(50);
    served = await serveMcp(() => createMockButler(state));
    await mgr.configure([{ id: "butler", name: "Butler", url: served.url, auth: { type: "none" } }]);
  });
  afterAll(async () => {
    await mgr.close();
    await served.close();
  });

  it("routes the golden opening utterances to the right tools", async () => {
    const brain = new BedrockBrain({ model: process.env.BEDROCK_MODEL_BRAIN || "us.amazon.nova-2-lite-v1:0" });
    const ctx: BrainContext = {
      tools: mgr.allTools().filter(isModelVisible).map((t) => ({ server: t.server, name: t.name, description: t.description, inputSchema: t.inputSchema })),
      servers: [{ id: "butler", name: "Butler", invocationName: "Butler" }],
      callTool: (s, t, a) => mgr.callTool(s, t, a),
    };
    const conv = newConversation("live");
    const t1 = await brain.turn(conv, "Tell Butler six friends from the dinner crew are coming over Friday at 7.", ctx);
    expect(t1.calls.map((c) => c.tool)).toEqual(["handle_situation"]);
    const t2 = await brain.turn(conv, "How's Friday looking?", ctx);
    expect(t2.calls.map((c) => c.tool)).toEqual(["get_status"]);
    expect(t2.spoken.length).toBeGreaterThan(5);
  }, 60_000);
});
