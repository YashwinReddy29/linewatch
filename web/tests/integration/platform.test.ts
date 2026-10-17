import { closeAll, incidentBody, req, resetDatabase, sessionHeaders, WORKER_AUTH } from "../helpers";

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { POST as login } from "@/app/api/auth/login/route";
import { GET as healthz } from "@/app/api/healthz/route";
import { POST as ingestRoute } from "@/app/api/incidents/route";
import { GET as metricsRoute } from "@/app/api/metrics/route";
import { GET as readyz } from "@/app/api/readyz/route";
import { GET as activeZone } from "@/app/api/zones/active/route";
import { DELETE as clearZone, PUT as saveZone } from "@/app/api/zones/route";
import { publish, subscribe } from "@/lib/bus";
import { clearLoginFailures } from "@/lib/auth";
import { pool, query } from "@/lib/db";
import { migrate, migrationsDir, pendingMigrations } from "@/lib/migrate";
import type { BusEvent } from "@/lib/types";

const tryLogin = (password: string) => login(req("/api/auth/login", { method: "POST", json: { password } }), undefined);

describe("login", () => {
  before(() => clearLoginFailures("all"));
  after(() => clearLoginFailures("all"));

  it("sets an HttpOnly SameSite=Strict cookie for the right password", async () => {
    const res = await tryLogin(process.env.ADMIN_PASSWORD!);
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^lw_session=[\w-]+\.[\w-]+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it("refuses a wrong password, then rate-limits: 401 x5, then 429 with Retry-After", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await tryLogin("wrong")).status, 401);
    const blocked = await tryLogin(process.env.ADMIN_PASSWORD!);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  });
});

describe("zones", () => {
  before(resetDatabase);
  after(closeAll);

  it("saves one active zone at a time and serves it to the worker", async () => {
    const headers = await sessionHeaders();
    const pts = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]];
    assert.equal((await saveZone(req("/api/zones", { method: "PUT", headers, json: { name: "Bay 1", points: pts } }), undefined)).status, 200);
    assert.equal((await saveZone(req("/api/zones", { method: "PUT", headers, json: { name: "Bay 2", points: pts } }), undefined)).status, 200);
    const { rows } = await query<{ n: string }>("SELECT count(*) AS n FROM zones WHERE active");
    assert.equal(rows[0].n, "1");

    const forWorker = await activeZone(req("/api/zones/active", { headers: WORKER_AUTH }), undefined);
    assert.equal((await forWorker.json()).zone.name, "Bay 2");
    assert.equal((await activeZone(req("/api/zones/active"), undefined)).status, 401);
    assert.equal(
      (await activeZone(req("/api/zones/active", { headers: { authorization: "Bearer nope" } }), undefined)).status,
      401,
    );

    assert.equal((await clearZone(req("/api/zones", { method: "DELETE", headers }), undefined)).status, 200);
    assert.equal((await (await activeZone(req("/x", { headers: WORKER_AUTH }), undefined)).json()).zone, null);
  });

  it("rejects bad zones with 400 and anonymous writes with 401", async () => {
    const headers = await sessionHeaders();
    const bad = await saveZone(req("/api/zones", { method: "PUT", headers, json: { name: "Bay", points: [[0, 0]] } }), undefined);
    assert.equal(bad.status, 400);
    const anon = await saveZone(req("/api/zones", { method: "PUT", json: { name: "Bay", points: [[0, 0], [1, 0], [1, 1]] } }), undefined);
    assert.equal(anon.status, 401);
  });
});

describe("health, readiness, metrics", () => {
  before(resetDatabase);
  after(closeAll);

  it("healthz is always ok; readyz checks config, database and migrations", async () => {
    assert.equal((await healthz(req("/api/healthz"), undefined)).status, 200);
    const ready = await readyz(req("/api/readyz"), undefined);
    assert.equal(ready.status, 200);
    assert.deepEqual((await ready.json()).checks, { config: "ok", database: "ok", migrations: "ok" });

    const saved = process.env.WORKER_TOKEN;
    process.env.WORKER_TOKEN = "short";
    try {
      const notReady = await readyz(req("/api/readyz"), undefined);
      assert.equal(notReady.status, 503);
      assert.match((await notReady.json()).checks.config, /WORKER_TOKEN/);
    } finally {
      process.env.WORKER_TOKEN = saved;
    }
  });

  it("metrics are off without METRICS_TOKEN, and need it when set", async () => {
    assert.equal((await metricsRoute(req("/api/metrics"), undefined)).status, 404);
    process.env.METRICS_TOKEN = "metrics-token-123";
    try {
      assert.equal((await metricsRoute(req("/api/metrics"), undefined)).status, 401);
      await ingestRoute(req("/api/incidents", { method: "POST", headers: WORKER_AUTH, json: incidentBody() }), undefined);
      const res = await metricsRoute(req("/api/metrics", { headers: { authorization: "Bearer metrics-token-123" } }), undefined);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /linewatch_incidents_ingested_total\{result="created"\} \d+/);
      assert.match(text, /linewatch_http_request_duration_seconds_bucket/);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });
});

describe("migrations", () => {
  before(resetDatabase);
  after(closeAll);

  it("apply once, record every file, and are a no-op when run again concurrently", async () => {
    const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql"));
    const runs = await Promise.all([migrate(pool()), migrate(pool()), migrate(pool())]);
    assert.equal(runs.flat().length, files.length, "each migration applied exactly once across 3 runners");
    assert.deepEqual(await pendingMigrations(pool()), []);
  });

  it("adopt a database created by the pre-migration schema.sql", async () => {
    await resetDatabase();
    // The original v0.1 schema, as databases created before migrations existed have it.
    await pool().query(`
      CREATE TABLE zones (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, points JSONB NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE incidents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tracker_id INTEGER NOT NULL, zone_id TEXT,
        zone_name TEXT, rule TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, triggered_at TIMESTAMPTZ NOT NULL,
        duration_s REAL NOT NULL, violating_frames INTEGER NOT NULL, window_frames INTEGER NOT NULL, confidence REAL NOT NULL,
        bbox JSONB NOT NULL, has_snapshot BOOLEAN NOT NULL DEFAULT FALSE, has_raw BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'false_alarm')), reviewed_at TIMESTAMPTZ,
        roboflow_status TEXT CHECK (roboflow_status IN ('uploading', 'uploaded', 'failed', 'skipped')),
        roboflow_image_id TEXT, roboflow_error TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO incidents (tracker_id, rule, started_at, triggered_at, duration_s, violating_frames, window_frames, confidence, bbox, status)
        VALUES (7, 'no_vest_in_zone', now(), now(), 1, 4, 6, 0.8, '[0,0,1,1]', 'confirmed');`);
    await migrate(pool());
    const { rows } = await pool().query<{ n: string; attempts: number }>(
      "SELECT count(*)::text AS n, min(roboflow_attempts) AS attempts FROM incidents",
    );
    assert.deepEqual(rows[0], { n: "1", attempts: 0 }, "existing incidents survive");
  });
});

describe("live events over LISTEN/NOTIFY", () => {
  before(resetDatabase);
  after(closeAll);

  it("delivers a published event to a subscriber", async () => {
    const got: BusEvent[] = [];
    const unsubscribe = await subscribe((e) => got.push(e));
    await publish({ type: "zone.updated", zone: null });
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    unsubscribe();
    assert.deepEqual(got, [{ type: "zone.updated", zone: null }]);
  });
});
