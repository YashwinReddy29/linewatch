import { publish } from "@/lib/bus";
import { insertIncident, listIncidents, markSnapshots, type NewIncident } from "@/lib/db";
import { json, problem, workerAuthorized } from "@/lib/server";
import { saveSnapshot } from "@/lib/storage";
import type { IncidentStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES = ["open", "confirmed", "false_alarm", "all"] as const;

export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") ?? "all";
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    return problem(`status must be one of ${STATUSES.join(", ")}`, 400);
  }
  return json({ incidents: await listIncidents(status as IncidentStatus | "all") });
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parse(body: Record<string, unknown>): NewIncident | string {
  const bbox = body.bbox;
  if (!num(body.trackerId)) return "trackerId must be a number";
  if (typeof body.rule !== "string") return "rule must be a string";
  for (const key of ["startedAt", "triggeredAt"]) {
    if (typeof body[key] !== "string" || Number.isNaN(Date.parse(body[key] as string))) {
      return `${key} must be an ISO date`;
    }
  }
  for (const key of ["durationS", "violatingFrames", "windowFrames", "confidence"]) {
    if (!num(body[key])) return `${key} must be a number`;
  }
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(num)) return "bbox must be [x1, y1, x2, y2]";
  return {
    trackerId: body.trackerId,
    zoneId: typeof body.zoneId === "string" ? body.zoneId : null,
    zoneName: typeof body.zoneName === "string" ? body.zoneName : null,
    rule: body.rule,
    startedAt: body.startedAt as string,
    triggeredAt: body.triggeredAt as string,
    durationS: body.durationS as number,
    violatingFrames: body.violatingFrames as number,
    windowFrames: body.windowFrames as number,
    confidence: body.confidence as number,
    bbox: bbox as [number, number, number, number],
  };
}

/** Called by the worker when the incident rule fires. */
export async function POST(req: Request) {
  if (!workerAuthorized(req)) return problem("Invalid worker token", 401);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return problem("Body must be JSON", 400);
  const parsed = parse(body);
  if (typeof parsed === "string") return problem(parsed, 400);

  let incident = await insertIncident(parsed);
  const annotated = typeof body.snapshotJpegBase64 === "string" ? body.snapshotJpegBase64 : null;
  const raw = typeof body.rawJpegBase64 === "string" ? body.rawJpegBase64 : null;
  if (annotated) await saveSnapshot(incident.id, "annotated", annotated);
  if (raw) await saveSnapshot(incident.id, "raw", raw);
  if (annotated || raw) incident = await markSnapshots(incident.id, Boolean(annotated), Boolean(raw));

  publish({ type: "incident.created", incident });
  return json({ incident }, 201);
}
