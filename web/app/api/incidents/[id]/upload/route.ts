import { getIncident } from "@/lib/db";
import { sendToRoboflow } from "@/lib/review";
import { json, problem } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Retry sending a false alarm's frame to Roboflow. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) return problem("Incident not found", 404);
  if (incident.status !== "false_alarm") return problem("Only false alarms are sent to Roboflow", 409);
  await sendToRoboflow(id);
  return json({ incident: await getIncident(id) });
}
