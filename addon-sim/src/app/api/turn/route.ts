import { getConversation } from "@/lib/brain/session";
import type { BrainContext } from "@/lib/brain/types";
import type { TurnEvent } from "@/lib/events";
import { isModelVisible, resolveUiResourceUri } from "@/lib/mcp/tools";
import { getHub } from "@/lib/server/hub";
import { ndjson } from "@/lib/server/ndjson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One conversational turn: utterance in, NDJSON stream of tool-call events and the spoken reply out. */
export async function POST(req: Request) {
  const body = (await req.json()) as { sessionId?: string; utterance?: string; model?: string };
  const utterance = (body.utterance ?? "").trim();
  if (!utterance) return Response.json({ error: "utterance required" }, { status: 400 });
  const hub = getHub();
  const conv = getConversation(body.sessionId ?? "default");

  return ndjson<TurnEvent>(async (emit) => {
    const t0 = performance.now();
    const turnId = `turn_${Date.now().toString(36)}`;
    emit({ type: "turn_start", turnId, utterance, llmMode: hub.llmMode });
    await hub.ensure();
    let n = 0;
    const ctx: BrainContext = {
      tools: hub.manager
        .allTools()
        .filter(isModelVisible)
        .map((t) => ({ server: t.server, name: t.name, description: t.description, inputSchema: t.inputSchema })),
      servers: hub.manager
        .list()
        .filter((c) => c.status === "connected")
        .map((c) => ({ id: c.id, name: c.name, invocationName: hub.servers.find((s) => s.id === c.id)?.invocationName })),
      callTool: async (server, tool, args) => {
        const callId = `${turnId}_${++n}`;
        const def = hub.manager.findTool(server, tool);
        emit({ type: "call_start", callId, server, tool, args, uiResourceUri: resolveUiResourceUri(def, undefined), at: Date.now() });
        const rec = await hub.manager.callTool(server, tool, args, { origin: "brain" });
        rec.id = callId;
        emit({ type: "call_end", record: rec });
        return rec;
      },
    };
    const turn = await hub.brainFor(body.model).turn(conv, utterance, ctx);
    emit({ type: "turn_end", turnId, spoken: turn.spoken, routing: turn.routing, clarification: turn.clarification, usage: turn.usage, ms: Math.round(performance.now() - t0) });
  });
}
