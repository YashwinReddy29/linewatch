import { requireSession } from "@/lib/auth";
import { isUuid } from "@/lib/db";
import { notFound, route } from "@/lib/http";
import { readSnapshot } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/incidents/:id/snapshot            annotated frame (boxes drawn)
 *  GET /api/incidents/:id/snapshot?kind=raw   the clean frame, as sent to Roboflow */
export const GET = route<Ctx>("incidents.snapshot", async (req, { params }) => {
  await requireSession(req);
  const { id } = await params;
  if (!isUuid(id)) throw notFound("Snapshot not found");
  const kind = new URL(req.url).searchParams.get("kind") === "raw" ? "raw" : "annotated";
  const jpeg = await readSnapshot(id, kind);
  if (!jpeg) throw notFound("Snapshot not found");
  // Snapshots never change once written, but they are people on a work site: private cache only.
  return new Response(new Uint8Array(jpeg), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400, immutable" },
  });
});
