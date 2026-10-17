import { problem, workerUrl } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The latest clean camera frame, proxied from the worker so the zone editor works anywhere. */
export async function GET() {
  try {
    const res = await fetch(`${workerUrl()}/frame.jpg`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!res.ok) return problem("The worker has no frame yet", 503);
    return new Response(await res.arrayBuffer(), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch {
    return problem("Can't reach the worker", 503);
  }
}
