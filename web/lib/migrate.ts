import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

/** Arbitrary constant: every web process takes this advisory lock while migrating. */
const MIGRATION_LOCK = 4_771_002_315;

/** The SQL files ship next to the server (the Dockerfile copies db/); keep them out of the bundle trace. */
export function migrationsDir(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), "db", "migrations");
}

/**
 * Applies db/migrations/NNNN_name.sql in order, each in its own transaction, and records it in
 * schema_migrations. Safe to run from several processes at once: the advisory lock serializes
 * them and the second one finds nothing left to do. Returns the versions it applied.
 */
export async function migrate(pool: Pool, dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = await readFile(path.join(/* turbopackIgnore: true */ dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Versions on disk that the database hasn't applied yet (readiness check). */
export async function pendingMigrations(pool: Pool, dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  const exists = await pool.query<{ ok: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok");
  const done = exists.rows[0].ok
    ? new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version))
    : new Set<string>();
  return files.map((f) => f.replace(/\.sql$/, "")).filter((v) => !done.has(v));
}
