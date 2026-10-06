import { pollyAllowed, synthesize } from "@/lib/voice/polly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Amazon Polly neural TTS. 503 tells the browser to fall back to speechSynthesis. */
export async function POST(req: Request) {
  if (!pollyAllowed()) return Response.json({ fallback: true, reason: "Polly is only used when LLM_MODE=bedrock" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { text?: string; voiceId?: string };
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  try {
    const audio = await synthesize(text, { voiceId: body.voiceId });
    return new Response(audio as unknown as BodyInit, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ fallback: true, reason: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
