import { requireSession } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { getIncident, requeueUpload } from "@/lib/db";
import { ApiError, json, notFound, route } from "@/lib/http";
import { roboflowConfig } from "@/lib/roboflow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/incidents/:id/upload — put a failed (or skipped) upload back in the queue. */
export const POST = route<Ctx>("incidents.retryUpload", async (req, { params }) => {
  await requireSession(req);
  const { id } = await params;
  const before = await getIncident(id);
  if (!before) throw notFound("Incident not found");
  if (before.status !== "false_alarm") throw new ApiError(409, "not_false_alarm", "Only false alarms are sent to Roboflow");
  if (!roboflowConfig().configured) {
    throw new ApiError(409, "roboflow_not_configured", "Set ROBOFLOW_API_KEY and ROBOFLOW_PROJECT first");
  }
  const incident = await requeueUpload(id);
  if (!incident) throw new ApiError(409, "not_retryable", `The upload is ${before.roboflowStatus ?? "not queued"}, not failed`);
  await publish({ type: "incident.updated", incident });
  return json({ incident }, 202);
});
