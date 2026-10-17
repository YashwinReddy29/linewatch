/**
 * Test setup shared by every test file. Imported first, so env is in place before any module
 * reads it. Integration tests need a Postgres they may wipe: TEST_DATABASE_URL.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://linewatch:linewatch@127.0.0.1:5432/linewatch_test";
process.env.WORKER_TOKEN = "test-worker-token-0123456789";
process.env.ADMIN_PASSWORD = "correct horse battery staple";
process.env.SESSION_SECRET = "s".repeat(48);
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "linewatch-test-"));
process.env.JOBS_ENABLED = "false";
process.env.UPLOAD_BACKOFF_MS = "1000";
process.env.UPLOAD_MAX_ATTEMPTS = "3";
delete process.env.AUTH_DISABLED;
delete process.env.TRUST_PROXY;
delete process.env.METRICS_TOKEN;
delete process.env.ROBOFLOW_API_KEY;
delete process.env.ROBOFLOW_PROJECT;

import { randomUUID } from "node:crypto";

import { Pool } from "pg";

export const WORKER_AUTH = { authorization: `Bearer ${process.env.WORKER_TOKEN}` };

/** Drops everything and lets the app migrate from scratch on its next query. */
export async function resetDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await admin.end();
  }
  (globalThis as { __lwReady?: unknown }).__lwReady = undefined;
}

export async function closeAll(): Promise<void> {
  const { closeBus } = await import("@/lib/bus");
  await closeBus();
  const g = globalThis as { __lwPool?: Pool; __lwReady?: unknown };
  await g.__lwPool?.end().catch(() => undefined);
  g.__lwPool = undefined;
  g.__lwReady = undefined;
}

/** Smallest valid JPEG prefix the ingest check accepts, padded with bytes. */
export const TINY_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");

export function incidentBody(overrides: Record<string, unknown> = {}) {
  const triggered = new Date();
  return {
    id: randomUUID(),
    trackerId: 7,
    zoneId: "zone-1",
    zoneName: "Loading bay 2",
    rule: "no_vest_in_zone",
    startedAt: new Date(triggered.getTime() - 2000).toISOString(),
    triggeredAt: triggered.toISOString(),
    durationS: 2,
    violatingFrames: 4,
    windowFrames: 6,
    confidence: 0.81,
    bbox: [0.1, 0.2, 0.3, 0.6],
    snapshotJpegBase64: TINY_JPEG,
    rawJpegBase64: TINY_JPEG,
    ...overrides,
  };
}

export function req(url: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return new Request(new URL(url, "http://localhost:3000"), { ...init, headers, body });
}

export async function sessionHeaders(): Promise<Record<string, string>> {
  const { createSessionToken, SESSION_COOKIE } = await import("@/lib/auth");
  return { cookie: `${SESSION_COOKIE}=${await createSessionToken()}`, host: "localhost:3000" };
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });
