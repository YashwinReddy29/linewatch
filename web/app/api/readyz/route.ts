import { pool, ready } from "@/lib/db";
import { configProblems } from "@/lib/env";
import { json, route } from "@/lib/http";
import { pendingMigrations } from "@/lib/migrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Readiness: config is complete, Postgres answers, and every migration is applied. */
export const GET = route("readyz", async () => {
  const checks: Record<string, string> = {};
  const problems = configProblems();
  checks.config = problems.length ? problems.join("; ") : "ok";
  try {
    await ready();
    await pool().query("SELECT 1");
    checks.database = "ok";
    const pending = await pendingMigrations(pool());
    checks.migrations = pending.length ? `pending: ${pending.join(", ")}` : "ok";
  } catch (err) {
    checks.database = err instanceof Error ? err.message : String(err);
    checks.migrations ??= "unknown";
  }
  const ok = Object.values(checks).every((v) => v === "ok");
  return json({ status: ok ? "ready" : "not_ready", checks }, ok ? 200 : 503);
});
