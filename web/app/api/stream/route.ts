import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiError, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The live MJPEG view, proxied from the worker. The browser only ever talks to the web app,
 * so the worker's port needn't be published and the stream sits behind the console login.
 */
export const GET = route("stream", async (req) => {
  await requireSession(req);
  let upstream: Response;
  try {
    upstream = await fetch(`${env.workerUrl()}/stream.mjpg`, { cache: "no-store", signal: req.signal });
  } catch {
    throw new ApiError(503, "worker_unreachable", "Can't reach the worker");
  }
  if (!upstream.ok || !upstream.body) throw new ApiError(503, "no_stream", "The worker has no live view yet");
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
