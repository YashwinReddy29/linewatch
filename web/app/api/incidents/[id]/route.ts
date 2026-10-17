import { getIncident } from "@/lib/db";
import { json, problem } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await getIncident(id);
  return incident ? json({ incident }) : problem("Incident not found", 404);
}
