import { requireSession } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { setIncidentStatus } from "@/lib/db";
import { json, notFound, readJson, route } from "@/lib/http";
import { metrics } from "@/lib/metrics";
import { roboflowConfig } from "@/lib/roboflow";
import { parse, reviewIn } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/incidents/:id/review  { status: "open" | "confirmed" | "false_alarm" }
 * Marking a false alarm queues the Roboflow upload in the same UPDATE; the upload loop
 * (lib/jobs.ts) sends it, so the response never waits on Roboflow.
 */
export const POST = route<Ctx>("incidents.review", async (req, { params }) => {
  await requireSession(req);
  const { status } = parse(reviewIn, await readJson(req, 4096));
  const incident = await setIncidentStatus((await params).id, status, roboflowConfig().configured);
  if (!incident) throw notFound("Incident not found");
  metrics.reviews.inc({ status });
  await publish({ type: "incident.updated", incident });
  return json({ incident });
});
