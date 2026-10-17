import type { WorkerHealth } from "./types";

/** URL the web server uses to reach the worker (inside compose: http://worker:8090). */
export const workerUrl = () => (process.env.WORKER_URL ?? "http://localhost:8090").replace(/\/$/, "");

/** URL the browser uses for the live MJPEG stream. */
export const streamUrl = () =>
  (process.env.STREAM_PUBLIC_URL ?? "http://localhost:8090").replace(/\/$/, "") + "/stream.mjpg";

export const siteName = () => process.env.SITE_NAME ?? "Demo site";

export function workerAuthorized(req: Request): boolean {
  const token = process.env.WORKER_TOKEN;
  if (!token) return true; // local dev without a token
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function fetchWorkerHealth(): Promise<WorkerHealth> {
  try {
    const res = await fetch(`${workerUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as WorkerHealth;
  } catch {
    return {
      state: "offline",
      message: `Can't reach the worker at ${workerUrl()}. Start it with docker compose up or make worker.`,
    };
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function problem(message: string, status: number): Response {
  return json({ error: message }, status);
}
