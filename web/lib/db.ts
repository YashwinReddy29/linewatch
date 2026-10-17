import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { env } from "./env";
import { badRequest } from "./http";
import { log } from "./log";
import { migrate } from "./migrate";
import type { Counts, Incident, IncidentStatus, RoboflowStatus, Zone } from "./types";
import type { IncidentIn } from "./validation";

const g = globalThis as unknown as { __lwPool?: Pool; __lwReady?: Promise<void> };

export function pool(): Pool {
  if (!g.__lwPool) {
    const connectionString = env.databaseUrl();
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    g.__lwPool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000, // no query may hold a connection forever
    });
    g.__lwPool.on("error", (err) => log.error({ err }, "idle Postgres client error"));
  }
  return g.__lwPool;
}

/** Runs pending migrations once per process; every query waits for it. */
export function ready(): Promise<void> {
  if (!g.__lwReady) {
    g.__lwReady = migrate(pool())
      .then((applied) => {
        if (applied.length) log.info({ applied }, "migrations applied");
      })
      .catch((err) => {
        g.__lwReady = undefined; // retry on the next request
        throw err;
      });
  }
  return g.__lwReady;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
  await ready();
  return pool().query<T>(text, params);
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
  roboflow_attempts: number;
  roboflow_next_attempt_at: Date | null;
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
    roboflowAttempts: r.roboflow_attempts,
    roboflowNextAttemptAt: r.roboflow_next_attempt_at ? r.roboflow_next_attempt_at.toISOString() : null,
  };
}

/**
 * Idempotent insert keyed by the worker-generated id. A retried POST (the worker never saw
 * the first response) hits ON CONFLICT and gets the stored row back with created=false.
 */
export async function insertIncident(
  n: IncidentIn,
  snapshots: { hasSnapshot: boolean; hasRaw: boolean },
): Promise<{ incident: Incident; created: boolean }> {
  const { rows } = await query<IncidentRow>(
    `INSERT INTO incidents
       (id, tracker_id, zone_id, zone_name, rule, started_at, triggered_at, duration_s,
        violating_frames, window_frames, confidence, bbox, has_snapshot, has_raw)
     VALUES ($1,$2,$3,$4,$5,
             date_trunc('milliseconds', $6::timestamptz), date_trunc('milliseconds', $7::timestamptz),
             $8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      n.id,
      n.trackerId,
      n.zoneId ?? null,
      n.zoneName ?? null,
      n.rule,
      n.startedAt,
      n.triggeredAt,
      n.durationS,
      n.violatingFrames,
      n.windowFrames,
      n.confidence,
      JSON.stringify(n.bbox),
      snapshots.hasSnapshot,
      snapshots.hasRaw,
    ],
  );
  if (rows[0]) return { incident: toIncident(rows[0]), created: true };
  const existing = await getIncident(n.id);
  if (!existing) throw new Error(`Incident ${n.id} conflicted but could not be read back`);
  return { incident: existing, created: false };
}

export interface ListFilter {
  status: IncidentStatus | "all";
  zoneId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

/**
 * The cursor carries triggeredAt as an ISO string, which has millisecond precision. That is
 * exact only because times are stored truncated to milliseconds (insertIncident, migration 0003);
 * with microseconds in the table, rows sharing the boundary's millisecond would be skipped.
 */
export function encodeCursor(i: Pick<Incident, "triggeredAt" | "id">): string {
  return Buffer.from(`${i.triggeredAt}|${i.id}`).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || Number.isNaN(Date.parse(at)) || !isUuid(id ?? "")) throw badRequest("cursor is invalid", "bad_cursor");
  return [at, id];
}

/** Keyset pagination, newest first: stable under inserts, unlike OFFSET. */
export async function listIncidents(f: ListFilter): Promise<{ incidents: Incident[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.status !== "all") add("status = ?", f.status);
  if (f.zoneId) add("zone_id = ?", f.zoneId);
  if (f.from) add("triggered_at >= ?", f.from);
  if (f.to) add("triggered_at < ?", f.to);
  if (f.cursor) {
    const [at, id] = decodeCursor(f.cursor);
    params.push(at, id);
    where.push(`(triggered_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(f.limit + 1);
  const { rows } = await query<IncidentRow>(
    `SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY triggered_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, f.limit).map(toIncident);
  return { incidents: page, nextCursor: rows.length > f.limit ? encodeCursor(page[page.length - 1]) : null };
}

export async function getIncident(id: string): Promise<Incident | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<IncidentRow>(`SELECT * FROM incidents WHERE id = $1`, [id]);
  return rows[0] ? toIncident(rows[0]) : null;
}

/**
 * Saves a review and moves the upload job with it, in one statement:
 *  - marked false alarm, never uploaded  -> queued (or skipped when Roboflow isn't configured)
 *  - un-marked while still queued        -> job cancelled (status back to NULL)
 *  - already uploaded / uploading / failed -> left alone
 */
export async function setIncidentStatus(id: string, status: IncidentStatus, roboflowConfigured: boolean): Promise<Incident | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET
       status = $2,
       reviewed_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END,
       roboflow_status = CASE
         WHEN $2 = 'false_alarm' AND (roboflow_status IS NULL OR roboflow_status = 'skipped')
           THEN CASE WHEN $3 THEN 'queued' ELSE 'skipped' END
         WHEN $2 <> 'false_alarm' AND roboflow_status IN ('queued', 'skipped') THEN NULL
         ELSE roboflow_status END,
       roboflow_attempts = CASE
         WHEN $2 = 'false_alarm' AND (roboflow_status IS NULL OR roboflow_status = 'skipped') THEN 0
         ELSE roboflow_attempts END,
       roboflow_next_attempt_at = CASE
         WHEN $2 = 'false_alarm' AND (roboflow_status IS NULL OR roboflow_status = 'skipped') AND $3 THEN now()
         WHEN $2 <> 'false_alarm' AND roboflow_status = 'queued' THEN NULL
         ELSE roboflow_next_attempt_at END,
       roboflow_error = CASE
         WHEN $2 = 'false_alarm' AND (roboflow_status IS NULL OR roboflow_status = 'skipped') AND NOT $3
           THEN 'Set ROBOFLOW_API_KEY and ROBOFLOW_PROJECT to send false alarms'
         WHEN $2 = 'false_alarm' AND (roboflow_status IS NULL OR roboflow_status = 'skipped') THEN NULL
         ELSE roboflow_error END
     WHERE id = $1 RETURNING *`,
    [id, status, roboflowConfigured],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

/** Manual retry of a failed (or skipped) upload: back to the queue with a fresh attempt budget. */
export async function requeueUpload(id: string): Promise<Incident | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET roboflow_status = 'queued', roboflow_attempts = 0,
       roboflow_next_attempt_at = now(), roboflow_error = NULL
     WHERE id = $1 AND status = 'false_alarm' AND roboflow_status IN ('failed', 'skipped')
     RETURNING *`,
    [id],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

/* ---------- upload jobs ---------- */

/**
 * Claims one due upload. `uploading` rows whose lease expired belong to a process that died
 * mid-upload, so they are claimed again. SKIP LOCKED lets several processes poll safely.
 */
export async function claimUpload(leaseSeconds: number): Promise<Incident | null> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET roboflow_status = 'uploading',
       roboflow_attempts = roboflow_attempts + 1,
       roboflow_locked_until = now() + make_interval(secs => $1::float8)
     WHERE id = (
       SELECT id FROM incidents
       WHERE status = 'false_alarm'
         AND ((roboflow_status = 'queued' AND roboflow_next_attempt_at <= now())
           OR (roboflow_status = 'uploading' AND roboflow_locked_until < now()))
       ORDER BY roboflow_next_attempt_at NULLS FIRST
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [leaseSeconds],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function completeUpload(id: string, imageId: string | null): Promise<Incident | null> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET roboflow_status = 'uploaded', roboflow_image_id = $2, roboflow_error = NULL,
       roboflow_locked_until = NULL, roboflow_next_attempt_at = NULL
     WHERE id = $1 AND roboflow_status = 'uploading' RETURNING *`,
    [id, imageId],
  );
  return rows[0] ? toIncident(rows[0]) : null;
}

/** Retryable failure with attempts left -> queued again after `retryInMs`; otherwise failed for good. */
export async function failUpload(id: string, error: string, retryInMs: number | null): Promise<Incident | null> {
  const { rows } = await query<IncidentRow>(
    `UPDATE incidents SET
       -- Un-marked as a false alarm while uploading: drop the job instead of retrying it.
       roboflow_status = CASE WHEN status <> 'false_alarm' THEN NULL
                              WHEN $3::float8 IS NULL THEN 'failed' ELSE 'queued' END,
       roboflow_next_attempt_at = CASE WHEN $3::float8 IS NULL THEN NULL
                                       ELSE now() + make_interval(secs => $3::float8 / 1000) END,
       roboflow_error = $2, roboflow_locked_until = NULL
     WHERE id = $1 AND roboflow_status = 'uploading' RETURNING *`,
    [id, error.slice(0, 500), retryInMs],
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
  return transaction(async (client) => {
    await client.query(`UPDATE zones SET active = FALSE WHERE active`);
    const { rows } = await client.query<ZoneRow>(
      `INSERT INTO zones (name, points, active) VALUES ($1, $2, TRUE) RETURNING *`,
      [name, JSON.stringify(points)],
    );
    return toZone(rows[0]);
  });
}

export async function clearActiveZone(): Promise<void> {
  await query(`UPDATE zones SET active = FALSE WHERE active`);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
