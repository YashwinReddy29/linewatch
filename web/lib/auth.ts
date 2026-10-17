/**
 * Two kinds of caller:
 *  - the worker, with a shared bearer token (WORKER_TOKEN), for ingest and zone polling;
 *  - a supervisor in the browser, with an HMAC-signed session cookie from /api/auth/login.
 *
 * Session tokens use Web Crypto only, so the same code runs in route handlers and in proxy.ts.
 */
import { ApiError } from "./http";
import { env } from "./env";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export { SESSION_COOKIE, createSessionToken, verifySessionToken } from "./session";

const encoder = new TextEncoder();

export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${env.sessionHours() * 3600}`,
  ];
  if (env.cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.cookieSecure() ? "; Secure" : ""}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request check for cookie-authenticated writes. SameSite=Strict already keeps
 * the cookie off cross-site requests; this is the second layer for browsers that send it.
 */
function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients (curl, scripts) don't send Origin
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "bad_origin", "Cross-site request refused");
  }
  if (!host || originHost !== host) throw new ApiError(403, "bad_origin", "Cross-site request refused");
}

/** Console routes: a valid session cookie (or AUTH_DISABLED=true in local dev). */
export async function requireSession(req: Request): Promise<void> {
  assertSameOrigin(req);
  if (env.authDisabled()) return;
  if (!(await verifySessionToken(cookieValue(req, SESSION_COOKIE)))) {
    throw new ApiError(401, "unauthenticated", "Sign in to the console first");
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Compares two secrets in constant time (hashing first makes the lengths equal). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length > 0;
}

/** Worker routes: `Authorization: Bearer <WORKER_TOKEN>`. Refuses everything if the token isn't configured. */
export async function requireWorker(req: Request): Promise<void> {
  const expected = env.workerToken();
  if (expected.length < 16) {
    throw new ApiError(503, "not_configured", "WORKER_TOKEN is not configured on the web app");
  }
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await secretsEqual(given, expected))) {
    throw new ApiError(401, "bad_worker_token", "Invalid worker token");
  }
}

/** Either caller. Used by read-only routes the worker and the console both need. */
export async function requireWorkerOrSession(req: Request): Promise<void> {
  if ((req.headers.get("authorization") ?? "").startsWith("Bearer ")) return requireWorker(req);
  return requireSession(req);
}

/* ---------- login rate limiting ---------- */

/**
 * Fixed-window failure counter per client address, in memory. Good enough for one web
 * process; several replicas would each count separately (documented limitation).
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const g = globalThis as unknown as { __lwLoginFailures?: Map<string, { count: number; resetAt: number }> };
const failures = g.__lwLoginFailures ?? (g.__lwLoginFailures = new Map());

/**
 * Route handlers can't see the socket address, and X-Forwarded-For is client-controlled
 * unless a trusted reverse proxy sets it. So per-address limits only apply with
 * TRUST_PROXY=true; otherwise every client shares one bucket (safe default for one admin).
 */
export function clientAddress(req: Request): string {
  if (process.env.TRUST_PROXY !== "true") return "all";
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function loginBlockedFor(address: string, now = Date.now()): number {
  const entry = failures.get(address);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

export function recordLoginFailure(address: string, now = Date.now()): void {
  const entry = failures.get(address);
  if (!entry || entry.resetAt <= now) failures.set(address, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearLoginFailures(address: string): void {
  failures.delete(address);
}
