import { requireWorkerOrSession } from "@/lib/auth";
import { getActiveZone } from "@/lib/db";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Polled by the worker every few seconds (bearer token). */
export const GET = route("zones.active", async (req) => {
  await requireWorkerOrSession(req);
  return json({ zone: await getActiveZone() });
});
