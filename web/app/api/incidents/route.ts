import { requireSession, requireWorker } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { insertIncident, listIncidents } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, json, readJson, route } from "@/lib/http";
import { log } from "@/lib/log";
import { metrics } from "@/lib/metrics";
import { saveSnapshot } from "@/lib/storage";
import { incidentIn, listQuery, parse } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/incidents?status=&zoneId=&from=&to=&limit=&cursor=
 * Newest first. `nextCursor` is null on the last page.
 */
export const GET = route("incidents.list", async (req) => {
  await requireSession(req);
  const q = parse(listQuery, Object.fromEntries(new URL(req.url).searchParams));
  return json(await listIncidents(q));
});

function isJpeg(base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 8), "base64");
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/**
 * POST /api/incidents — called by the worker when the incident rule fires.
 * Idempotent on `id`: 201 the first time, 200 with `duplicate: true` on any retry.
 */
export const POST = route("incidents.ingest", async (req, _ctx, requestId) => {
  await requireWorker(req);
  const body = parse(incidentIn, await readJson(req, env.maxIngestBytes()));
  for (const [key, value] of [
    ["snapshotJpegBase64", body.snapshotJpegBase64],
    ["rawJpegBase64", body.rawJpegBase64],
  ] as const) {
    if (value && !isJpeg(value)) throw badRequest(`${key}: must be a JPEG`, "validation_failed");
  }

  // Files first, row second: a row never points at a snapshot that isn't on disk.
  // Both writes are keyed by id, so a retried request repeats them harmlessly.
  if (body.snapshotJpegBase64) await saveSnapshot(body.id, "annotated", body.snapshotJpegBase64);
  if (body.rawJpegBase64) await saveSnapshot(body.id, "raw", body.rawJpegBase64);
  const { incident, created } = await insertIncident(body, {
    hasSnapshot: Boolean(body.snapshotJpegBase64),
    hasRaw: Boolean(body.rawJpegBase64),
  });

  metrics.incidentsIngested.inc({ result: created ? "created" : "duplicate" });
  if (!created) {
    log.info({ incidentId: incident.id, requestId }, "duplicate incident delivery");
    return json({ incident, duplicate: true }, 200);
  }
  await publish({ type: "incident.created", incident });
  return json({ incident, duplicate: false }, 201);
});
