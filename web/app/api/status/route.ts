import { countIncidents, getActiveZone } from "@/lib/db";
import { roboflowConfig, roboflowProjectUrl } from "@/lib/roboflow";
import { fetchWorkerHealth, json, siteName, streamUrl } from "@/lib/server";
import type { StatusResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [worker, zone, counts] = await Promise.all([fetchWorkerHealth(), getActiveZone(), countIncidents()]);
  const body: StatusResponse = {
    worker,
    zone,
    counts,
    roboflowConfigured: roboflowConfig().configured,
    roboflowProjectUrl: roboflowProjectUrl(),
    streamUrl: streamUrl(),
    siteName: siteName(),
  };
  return json(body);
}
