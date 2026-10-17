/** Node-only startup work, loaded by instrumentation.ts (kept separate so the Edge bundle never sees it). */
export async function startServer(): Promise<void> {
  const { ready, pool } = await import("./lib/db");
  const { startUploadLoop, stopUploadLoop } = await import("./lib/jobs");
  const { closeBus } = await import("./lib/bus");
  const { configProblems } = await import("./lib/env");
  const { log } = await import("./lib/log");

  for (const problem of configProblems()) log.error({ problem }, "configuration problem; /api/readyz will report not ready");
  try {
    await ready();
  } catch (err) {
    // Keep serving: /api/healthz stays up, /api/readyz reports the database problem, and
    // the next query retries the migrations.
    log.error({ err }, "migrations failed at startup");
  }
  startUploadLoop();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    stopUploadLoop();
    await closeBus();
    await pool().end().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
