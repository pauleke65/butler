/** Stream newline-delimited JSON from an async producer. */
export function ndjson<T>(run: (emit: (e: T) => void, signal: AbortSignal) => Promise<void>): Response {
  const enc = new TextEncoder();
  const ac = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: T) => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* client went away */
        }
      };
      try {
        await run(emit, ac.signal);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) } as unknown as T);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
