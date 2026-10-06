import { resetConversation } from "@/lib/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
  resetConversation(body.sessionId ?? "default");
  return Response.json({ ok: true });
}
