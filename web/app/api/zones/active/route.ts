import { getActiveZone } from "@/lib/db";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Polled by the worker every few seconds. */
export async function GET() {
  return json({ zone: await getActiveZone() });
}
