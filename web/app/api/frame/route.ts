import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiError, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The latest clean camera frame, proxied from the worker so the zone editor works anywhere. */
export const GET = route("frame", async (req) => {
  await requireSession(req);
  let res: Response;
  try {
    res = await fetch(`${env.workerUrl()}/frame.jpg`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  } catch {
    throw new ApiError(503, "worker_unreachable", "Can't reach the worker");
  }
  if (!res.ok) throw new ApiError(503, "no_frame", "The worker has no frame yet");
  return new Response(await res.arrayBuffer(), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
});
