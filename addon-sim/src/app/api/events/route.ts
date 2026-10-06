import type { HubEvent } from "@/lib/events";
import { getHub } from "@/lib/server/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events for things that happen outside a turn (elicitation requests). */
export async function GET(req: Request) {
  const hub = getHub();
  const enc = new TextEncoder();
  let off: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: HubEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* closed */
        }
      };
      off = hub.subscribe(send);
      send({ type: "hello" });
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          /* closed */
        }
      }, 15000);
      req.signal.addEventListener("abort", () => {
        off?.();
        if (ping) clearInterval(ping);
      });
    },
    cancel() {
      off?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}
