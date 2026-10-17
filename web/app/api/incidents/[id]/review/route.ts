import { publish } from "@/lib/bus";
import { setIncidentStatus } from "@/lib/db";
import { sendToRoboflow } from "@/lib/review";
import { json, problem } from "@/lib/server";
import type { IncidentStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED: IncidentStatus[] = ["open", "confirmed", "false_alarm"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  const status = body?.status as IncidentStatus | undefined;
  if (!status || !ALLOWED.includes(status)) {
    return problem(`status must be one of ${ALLOWED.join(", ")}`, 400);
  }
  const incident = await setIncidentStatus(id, status);
  if (!incident) return problem("Incident not found", 404);
  publish({ type: "incident.updated", incident });

  // The review is saved first; the Roboflow upload runs after the response so the button is instant.
  if (status === "false_alarm" && incident.roboflowStatus !== "uploaded") {
    void sendToRoboflow(id).catch((err) => console.error("Roboflow upload crashed", err));
  }
  return json({ incident });
}
