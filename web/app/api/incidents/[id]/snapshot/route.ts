import { isUuid } from "@/lib/db";
import { problem } from "@/lib/server";
import { readSnapshot } from "@/lib/storage";

export const runtime = "nodejs";

/** GET /api/incidents/:id/snapshot            annotated frame (boxes drawn)
 *  GET /api/incidents/:id/snapshot?kind=raw   the clean frame, as sent to Roboflow */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return problem("Incident not found", 404);
  const kind = new URL(req.url).searchParams.get("kind") === "raw" ? "raw" : "annotated";
  const jpeg = await readSnapshot(id, kind);
  if (!jpeg) return problem("Snapshot not found", 404);
  return new Response(new Uint8Array(jpeg), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
