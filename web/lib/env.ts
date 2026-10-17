/**
 * Every environment variable the web app reads, in one place.
 * Read lazily (functions, not constants) so tests can set process.env per case.
 */

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const env = {
  databaseUrl: () => str("DATABASE_URL"),
  dataDir: () => str("DATA_DIR"),
  workerUrl: () => str("WORKER_URL", "http://localhost:8090").replace(/\/$/, ""),
  siteName: () => str("SITE_NAME", "Demo site"),

  /** Shared secret the worker sends as `Authorization: Bearer …`. Required. */
  workerToken: () => str("WORKER_TOKEN"),
  /** Password for the console login. Required unless AUTH_DISABLED=true. */
  adminPassword: () => str("ADMIN_PASSWORD"),
  /** HMAC key for session cookies. At least 32 characters. */
  sessionSecret: () => str("SESSION_SECRET"),
  sessionHours: () => int("SESSION_HOURS", 12),
  /** Mark the session cookie Secure. Turn on whenever the console is served over HTTPS. */
  cookieSecure: () => str("COOKIE_SECURE") === "true",
  /** Local development only: skips the console login. Never set in a deployment. */
  authDisabled: () => str("AUTH_DISABLED") === "true",
  /** Bearer token for GET /api/metrics. Unset = metrics endpoint disabled. */
  metricsToken: () => str("METRICS_TOKEN"),

  /** Largest incident POST accepted (two base64 JPEGs). */
  maxIngestBytes: () => int("MAX_INGEST_BYTES", 8 * 1024 * 1024),

  roboflowApiKey: () => str("ROBOFLOW_API_KEY"),
  roboflowProject: () => str("ROBOFLOW_PROJECT"),
  roboflowWorkspace: () => str("ROBOFLOW_WORKSPACE"),
  uploadMaxAttempts: () => int("UPLOAD_MAX_ATTEMPTS", 5),
  uploadBackoffMs: () => int("UPLOAD_BACKOFF_MS", 2000),
  /** Set to false to run the web app without the background upload loop (e.g. a read-only replica). */
  jobsEnabled: () => str("JOBS_ENABLED", "true") !== "false",

  logLevel: () => str("LOG_LEVEL", "info"),
};

/** Problems that should stop the server from claiming it is ready. */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!env.databaseUrl()) problems.push("DATABASE_URL is not set");
  if (env.workerToken().length < 16) problems.push("WORKER_TOKEN must be at least 16 characters");
  if (!env.authDisabled()) {
    if (!env.adminPassword()) problems.push("ADMIN_PASSWORD is not set (or set AUTH_DISABLED=true for local dev)");
    if (env.sessionSecret().length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  }
  return problems;
}
