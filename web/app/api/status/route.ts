import { requireSession } from "@/lib/auth";
import { countIncidents, getActiveZone } from "@/lib/db";
import { env } from "@/lib/env";
import { json, route } from "@/lib/http";
import { roboflowConfig, roboflowProjectUrl } from "@/lib/roboflow";
import type { StatusResponse, WorkerHealth } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function fetchWorkerHealth(): Promise<WorkerHealth> {
  try {
    const res = await fetch(`${env.workerUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as WorkerHealth;
  } catch {
    return {
      state: "offline",
      message: `Can't reach the worker at ${env.workerUrl()}. Start it with docker compose up or make worker.`,
    };
  }
}

export const GET = route("status", async (req) => {
  await requireSession(req);
  const [worker, zone, counts] = await Promise.all([fetchWorkerHealth(), getActiveZone(), countIncidents()]);
  const body: StatusResponse = {
    worker,
    zone,
    counts,
    roboflowConfigured: roboflowConfig().configured,
    roboflowProjectUrl: roboflowProjectUrl(),
    siteName: env.siteName(),
    authEnabled: !env.authDisabled(),
  };
  return json(body);
});
