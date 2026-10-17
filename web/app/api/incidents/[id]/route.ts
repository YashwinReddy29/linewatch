import { requireSession } from "@/lib/auth";
import { getIncident } from "@/lib/db";
import { json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>("incidents.get", async (req, { params }) => {
  await requireSession(req);
  const incident = await getIncident((await params).id);
  if (!incident) throw notFound("Incident not found");
  return json({ incident });
});
