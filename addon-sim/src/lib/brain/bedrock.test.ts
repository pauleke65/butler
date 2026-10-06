import { describe, expect, it } from "vitest";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import type { CallRecord } from "../mcp/types";
import { BedrockBrain, toToolConfig, toolAlias, type ConverseLike } from "./bedrock";
import { createBrain, resolveLlmMode } from "./factory";
import { OfflineBrain } from "./offline";
import { newConversation } from "./session";
import type { BrainContext, BrainTool } from "./types";

const tools: BrainTool[] = [
  { server: "a", name: "get_status", description: "Use when asked how it is going.", inputSchema: { type: "object", properties: { plan_id: { type: "string" } } } },
  { server: "a", name: "weird name!", description: "x", inputSchema: { type: "object" } },
  { server: "b", name: "get_status", description: "clash", inputSchema: { type: "object" } },
];

function fakeRecord(spoken: string): CallRecord {
  return {
    id: "c1", server: "a", tool: "get_status", args: {}, origin: "brain",
    result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true, spoken_summary: spoken } },
    timings: { startedAt: "", ttfbMs: 1, totalMs: 2 },
  };
}

describe("BedrockBrain (fake Converse client)", () => {
  it("aliases tool names for Bedrock and disambiguates clashes", () => {
    expect(toolAlias(tools[0]!, tools)).toBe("a__get_status");
    expect(toolAlias(tools[1]!, tools)).toBe("weird_name_");
    const cfg = toToolConfig(tools);
    expect(cfg.tools).toHaveLength(3);
  });

  it("runs the tool-use loop: tool_use -> tool result -> final speech, and keeps memory", async () => {
    const seen: Message[][] = [];
    const responses = [
      { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "weird_name_", input: { q: 1 } } }] } as Message } },
      { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "All good, one thing for you." }] } as Message } },
    ];
    const client: ConverseLike = {
      send: async (cmd) => {
        seen.push(JSON.parse(JSON.stringify((cmd.input as { messages: Message[] }).messages)));
        return responses.shift()!;
      },
    };
    const brain = new BedrockBrain({ model: "m", client });
    const conv = newConversation("s");
    const calls: string[] = [];
    const ctx: BrainContext = { tools, servers: [{ id: "a", name: "A" }], callTool: async (s, t) => { calls.push(`${s}/${t}`); return fakeRecord("ok"); } };
    const turn = await brain.turn(conv, "how is it going", ctx);
    expect(calls).toEqual(["a/weird name!"]);
    expect(turn.spoken).toBe("All good, one thing for you.");
    expect(turn.usage?.steps).toBe(2);
    expect(conv.messages).toHaveLength(4); // user, assistant(toolUse), user(toolResult), assistant(text)
    expect(seen[1]!.at(-1)!.content![0]).toHaveProperty("toolResult");
  });

  it("caps tool calls per turn and falls back to spoken_summary when the model returns no text", async () => {
    const uses = [1, 2, 3].map((i) => ({ toolUse: { toolUseId: `t${i}`, name: "a__get_status", input: {} } }));
    const responses = [
      { stopReason: "tool_use", output: { message: { role: "assistant", content: uses } as Message } },
      { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "" }] } as Message } },
    ];
    const brain = new BedrockBrain({ model: "m", maxToolCalls: 1, client: { send: async () => responses.shift()! } });
    let n = 0;
    const turn = await brain.turn(newConversation("s2"), "go", { tools, servers: [], callTool: async () => { n++; return fakeRecord("Spoken from tool."); } });
    expect(n).toBe(1);
    expect(turn.spoken).toBe("Spoken from tool.");
  });
});

describe("factory", () => {
  it("picks the brain by LLM_MODE and defaults to offline", () => {
    expect(resolveLlmMode({})).toBe("offline");
    expect(createBrain({})).toBeInstanceOf(OfflineBrain);
    expect(createBrain({ LLM_MODE: "bedrock", AWS_REGION: "us-east-1" }).mode).toBe("bedrock");
  });
});
