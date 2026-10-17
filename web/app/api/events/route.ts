import { requireSession } from "@/lib/auth";
import { subscribe } from "@/lib/bus";
import { route } from "@/lib/http";
import { metrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent events: new incidents, review changes and zone changes, pushed to every open tab. */
export const GET = route("events", async (req) => {
  await requireSession(req);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      metrics.sseClients.inc();
      const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      let unsubscribe = () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        metrics.sseClients.dec();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
      unsubscribe = await subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      send(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
