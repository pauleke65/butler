import { getHub } from "@/lib/server/hub";
import type { ElicitationResponse } from "@/lib/mcp/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as { id?: string } & ElicitationResponse;
  if (!body.id || !["accept", "decline", "cancel"].includes(body.action)) return Response.json({ error: "id and action required" }, { status: 400 });
  const ok = getHub().answerElicitation(body.id, { action: body.action, content: body.content });
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
