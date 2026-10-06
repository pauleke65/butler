import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockButler, newMockState } from "../../../test/mock-server/butler-mock";
import { serveMcp, type ServedMcp } from "../../../test/support/http";
import { McpClientManager } from "../mcp/client-manager";
import { isModelVisible } from "../mcp/tools";
import { OfflineBrain, buildArgs, extractChoice, extractReference, parseAddressing, scoreTools } from "./offline";
import { newConversation } from "./session";
import type { BrainContext, BrainTool } from "./types";

let served: ServedMcp;
const mgr = new McpClientManager();
let tools: BrainTool[] = [];
const servers = [{ id: "butler", name: "Butler", invocationName: "Butler" }];

function ctx(): BrainContext {
  return { tools, servers, callTool: (s, t, a) => mgr.callTool(s, t, a) };
}

beforeAll(async () => {
  const st = newMockState(50);
  served = await serveMcp(() => createMockButler(st));
  await mgr.configure([{ id: "butler", name: "Butler", url: served.url, auth: { type: "none" }, invocationName: "Butler" }]);
  tools = mgr.allTools().filter(isModelVisible).map((t) => ({ server: t.server, name: t.name, description: t.description, inputSchema: t.inputSchema }));
});
afterAll(async () => {
  await mgr.close();
  await served.close();
});

describe("helpers", () => {
  it("parses invocation-name frames", () => {
    expect(parseAddressing("Tell Butler six friends are coming over Friday at 7.", servers)).toMatchObject({ addressed: true, serverId: "butler", cleaned: "six friends are coming over Friday at 7." });
    expect(parseAddressing("Ask Butler how Friday is looking", servers).cleaned).toBe("how Friday is looking");
    expect(parseAddressing("How's Friday looking?", servers).addressed).toBe(false);
  });
  it("extracts references and choices", () => {
    expect(extractReference("Why did you buy the drinks?")).toBe("the drinks");
    expect(extractReference("Explain the email to Tolu")).toBe("the email to Tolu");
    expect(extractChoice("Book BrightHome.")).toBe("BrightHome");
    expect(extractChoice("the second one")).toBe("the second one");
    expect(extractChoice("Yes.")).toBe("approve");
    expect(extractChoice("I'll take Sparkle Cleaners please")).toBe("Sparkle Cleaners");
  });
  it("model-visible tools exclude app-only tools", () => {
    expect(tools.map((t) => t.name)).not.toContain("get_plan");
    expect(tools.map((t) => t.name)).toContain("get_status");
  });
});

describe("routing table (descriptions only)", () => {
  const table: Array<[string, string]> = [
    ["Tell Butler six friends from the dinner crew are coming over Friday at 7.", "handle_situation"],
    ["How's Friday looking?", "get_status"],
    ["Book BrightHome.", "answer_decision"],
    ["Why did you buy the drinks?", "explain_action"],
    ["Don't buy drinks without asking me.", "object_to_action"],
    ["I'm travelling Thursday to Sunday. My parents are staying at the house.", "handle_situation"],
    ["Anything you need from me?", "get_status"],
    ["What did you do this week that I might disagree with?", "list_actions"],
    ["What are my rules?", "list_rules"],
    ["the second one", "answer_decision"],
    ["What did Butler buy today?", "list_actions"],
  ];
  it.each(table)("%s -> %s", (utterance, expected) => {
    const { addressed, serverId, cleaned } = parseAddressing(utterance, servers);
    const decision = scoreTools(cleaned, tools, addressed ? serverId : undefined);
    expect(decision?.tool.name, JSON.stringify(decision?.candidates)).toBe(expected);
  });

  it("is deterministic: the golden utterances pick the same tools 10 out of 10 times", () => {
    for (let run = 0; run < 10; run++) {
      for (const [utterance, expected] of table) {
        const { addressed, serverId, cleaned } = parseAddressing(utterance, servers);
        expect(scoreTools(cleaned, tools, addressed ? serverId : undefined)?.tool.name).toBe(expected);
      }
    }
  });

  it("fills enum filters from the utterance", () => {
    const la = tools.find((t) => t.name === "list_actions")!;
    expect(buildArgs(la, "What did you do this week that I might disagree with?")).toMatchObject({ filter: "might_disagree", period: "this_week" });
    expect(buildArgs(la, "What did you buy?")).toMatchObject({});
  });
});

describe("OfflineBrain conversation (golden-demo utterances against the mock server)", () => {
  it("runs the multi-turn flow incl. 'yes' bound to the pending rule confirmation", async () => {
    const brain = new OfflineBrain();
    const conv = newConversation("t1");
    const say = async (u: string) => brain.turn(conv, u, ctx());

    let t = await say("Tell Butler six friends from the dinner crew are coming over Friday at 7.");
    expect(t.calls[0]!.tool).toBe("handle_situation");
    expect(t.calls[0]!.args.situation).toBe("six friends from the dinner crew are coming over Friday at 7.");
    expect(t.spoken).toContain("six guests Friday at 7");

    t = await say("How's Friday looking?");
    expect(t.calls[0]!.tool).toBe("get_status");
    expect(t.spoken).toContain("which cleaner");

    t = await say("Book BrightHome.");
    expect(t.calls[0]!.tool).toBe("answer_decision");
    expect(t.calls[0]!.args.choice).toBe("BrightHome");
    expect(t.spoken).toContain("BrightHome");

    t = await say("Why did you buy the drinks?");
    expect(t.calls[0]!.tool).toBe("explain_action");
    expect(t.calls[0]!.args.reference).toBe("the drinks");

    t = await say("Don't buy drinks without asking me.");
    expect(t.calls[0]!.tool).toBe("object_to_action");
    expect((t.calls[0]!.result!.structuredContent as { needs_confirmation: boolean }).needs_confirmation).toBe(true);

    t = await say("Yes.");
    expect(t.calls[0]!.tool).toBe("object_to_action");
    expect(t.calls[0]!.args.confirm).toBe(true);
    expect(t.calls[0]!.args.correction).toBe("Don't buy drinks without asking me.");
    expect((t.calls[0]!.result!.structuredContent as { rule: { active: boolean } }).rule.active).toBe(true);

    t = await say("I'm travelling Thursday to Sunday. My parents are staying at the house.");
    expect(t.calls[0]!.tool).toBe("handle_situation");
    expect((t.calls[0]!.result!.structuredContent as { plan: { kind: string } }).plan.kind).toBe("away");

    t = await say("Anything you need from me?");
    expect(t.calls[0]!.tool).toBe("get_status");
    expect(t.spoken).toContain("31 dollars");

    t = await say("Yes.");
    expect(t.calls[0]!.tool).toBe("answer_decision");
    expect(t.calls[0]!.args.choice).toBe("approve");

    t = await say("What did you do this week that I might disagree with?");
    expect(t.calls[0]!.tool).toBe("list_actions");
    expect(t.calls[0]!.args.filter).toBe("might_disagree");
    const titles = (t.calls[0]!.result!.structuredContent as { actions: Array<{ title: string }> }).actions.map((a) => a.title);
    expect(titles).toContain("Booked BrightHome");
    expect(titles).toContain("Bought drinks");
  });

  it("declines politely when nothing is pending or nothing matches", async () => {
    const brain = new OfflineBrain();
    const conv = newConversation("t2");
    expect((await brain.turn(conv, "Yes.", ctx())).calls).toHaveLength(0);
    const t = await brain.turn(conv, "Purple monkey dishwasher", ctx());
    expect(t.calls).toHaveLength(0);
    expect(t.spoken).toMatch(/not sure/i);
  });

  it("asks a clarifying question on AMBIGUOUS_REFERENCE and resolves the answer", async () => {
    const state = newMockState(50);
    const s2 = await serveMcp(() => createMockButler(state));
    const m2 = new McpClientManager();
    await m2.configure([{ id: "butler", name: "Butler", url: s2.url, auth: { type: "none" } }]);
    const c: BrainContext = { tools, servers, callTool: (s, t, a) => m2.callTool(s, t, a) };
    const brain = new OfflineBrain();
    const conv = newConversation("t3");
    await brain.turn(conv, "Tell Butler six friends are coming over Friday at 7", c);
    await brain.turn(conv, "I'm travelling Thursday to Sunday, my parents are staying at the house", c);
    // two plans: force two pending decisions
    state.decisions.push({ ...state.decisions[0]!, decision_id: "dec_extra", question: "Which snack?", options: state.decisions[0]!.options });
    const t = await brain.turn(conv, "Book BrightHome", c);
    expect(t.clarification).toBe(true);
    expect(t.spoken).toMatch(/did you mean/i);
    await m2.close();
    await s2.close();
  });
});
