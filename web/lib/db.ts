import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type QueryResultRow } from "pg";

import type { Counts, Incident, IncidentStatus, RoboflowStatus, Zone } from "./types";

const globalForDb = globalThis as unknown as { __lwPool?: Pool; __lwSchema?: Promise<void> };

function pool(): Pool {
  if (!globalForDb.__lwPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForDb.__lwPool = new Pool({ connectionString, max: 5 });
  }
  return globalForDb.__lwPool;
}

function ensureSchema(): Promise<void> {
  if (!globalForDb.__lwSchema) {
    const sql = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
    globalForDb.__lwSchema = pool()
      .query(sql)
      .then(() => undefined)
      .catch((err) => {
        globalForDb.__lwSchema = undefined; // retry on next request
        throw err;
      });
  }
  return globalForDb.__lwSchema;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
  await ensureSchema();
  return pool().query<T>(text, params);
}

/* ---------- incidents ---------- */

interface IncidentRow {
  id: string;
  tracker_id: number;
  zone_id: string | null;
  zone_name: string | null;
  rule: string;
  started_at: Date;
  triggered_at: Date;
  duration_s: number;
  violating_frames: number;
  window_frames: number;
  confidence: number;
  bbox: [number, number, number, number];
  has_snapshot: boolean;
  has_raw: boolean;
  status: IncidentStatus;
  reviewed_at: Date | null;
  roboflow_status: RoboflowStatus;
  roboflow_image_id: string | null;
  roboflow_error: string | null;
}

function toIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    trackerId: r.tracker_id,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    rule: r.rule,
    startedAt: r.started_at.toISOString(),
    triggeredAt: r.triggered_at.toISOString(),
    durationS: r.duration_s,
    violatingFrames: r.violating_frames,
    windowFrames: r.window_frames,
    confidence: r.confidence,
    bbox: r.bbox,
    hasSnapshot: r.has_snapshot,
    hasRaw: r.has_raw,
    status: r.status,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    roboflowStatus: r.roboflow_status,
    roboflowImageId: r.roboflow_image_id,
    roboflowError: r.roboflow_error,
  };
}

export interface NewIncident {
  trackerId: number;
  zoneId: string | null;
  zoneName: string | null;
  rule: string;
  startedAt: string;
  triggeredAt: string;
  durationS: number;
  violatingFrames: number;
  windowFrames: number;
  confidence: number;
  bbox: [number, number, number, number];
}

export async function insertIncident(n: NewIncident): Promise<Incident> {
  const { rows } = await query<IncidentRow>(
    `INSERT INTO incidents
       (tracker_id, zone_id, zone_name, rule, started_at, triggered_at, duration_s,
        violating_frames, window_frames, confidence, bbox)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      n.trackerId,
      n.zoneId,
      n.zoneName,
      n.rule,
      n.startedAt,
      n.triggeredAt,
      n.durationS,
      n.violatingFrames,
      n.windowFrames,
      n.confidence,
      JSON.stringify(n.bbox),
    ],
  );
  return toIncident(rows[0]);
}

export async function markSnapshots(id: string, hasSnapshot: boolean, hasRaw: boolean): Promise<Incident> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET has_snapshot = $2, has_raw = $3 WHERE id = $1 RETURNING *`,
    [id, hasSnapshot, hasRaw],
  );
  return toIncident(rows[0]);
}

export async function listIncidents(status: IncidentStatus | "all", limit = 100): Promise<Incident[]> {
  const { rows } =
    status === "all"
      ? await query<IncidentRow>(`SELECT * FROM incidents ORDER BY triggered_at DESC LIMIT $1`, [limit])
      : await query<IncidentRow>(
          `SELECT * FROM incidents WHERE status = $1 ORDER BY triggered_at DESC LIMIT $2`,
          [status, limit],
        );
  return rows.map(toIncident);
}

export async function getIncident(id: string): Promise<Incident | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<IncidentRow>(`SELECT * FROM incidents WHERE id = $1`, [id]);
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function setIncidentStatus(id: string, status: IncidentStatus): Promise<Incident | null> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents
       SET status = $2, reviewed_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
     WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function setRoboflowState(
  id: string,
  state: RoboflowStatus,
  imageId: string | null = null,
  error: string | null = null,
): Promise<Incident | null> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET roboflow_status = $2, roboflow_image_id = $3, roboflow_error = $4
     WHERE id = $1 RETURNING *`,
    [id, state, imageId, error],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function countIncidents(): Promise<Counts> {
  const { rows } = await query<{ status: IncidentStatus; n: string }>(
    `SELECT status, count(*) AS n FROM incidents GROUP BY status`,
  );
  const counts: Counts = { open: 0, confirmed: 0, false_alarm: 0, all: 0 };
  for (const r of rows) {
    counts[r.status] = Number(r.n);
    counts.all += Number(r.n);
  }
  return counts;
}

/* ---------- zones ---------- */

interface ZoneRow {
  id: string;
  name: string;
  points: [number, number][];
  active: boolean;
  created_at: Date;
}

function toZone(r: ZoneRow): Zone {
  return { id: r.id, name: r.name, points: r.points, active: r.active, createdAt: r.created_at.toISOString() };
}

export async function getActiveZone(): Promise<Zone | null> {
  const { rows } = await query<ZoneRow>(`SELECT * FROM zones WHERE active LIMIT 1`);
  return rows[0] ? toZone(rows[0]) : null;
}

/** Saves a new zone and makes it the only active one, in one transaction. */
export async function saveActiveZone(name: string, points: [number, number][]): Promise<Zone> {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE zones SET active = FALSE WHERE active`);
    const { rows } = await client.query<ZoneRow>(
      `INSERT INTO zones (name, points, active) VALUES ($1, $2, TRUE) RETURNING *`,
      [name, JSON.stringify(points)],
    );
    await client.query("COMMIT");
    return toZone(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function clearActiveZone(): Promise<void> {
  await query(`UPDATE zones SET active = FALSE WHERE active`);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
