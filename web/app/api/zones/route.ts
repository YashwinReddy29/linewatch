import { requireSession } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { clearActiveZone, getActiveZone, saveActiveZone } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { parse, zoneIn } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route("zones.get", async (req) => {
  await requireSession(req);
  return json({ zone: await getActiveZone() });
});

/** PUT /api/zones { name, points: [[x, y], ...] } — replaces the active zone (normalized 0..1). */
export const PUT = route("zones.save", async (req) => {
  await requireSession(req);
  const { name, points } = parse(zoneIn, await readJson(req, 16 * 1024));
  const zone = await saveActiveZone(name, points);
  await publish({ type: "zone.updated", zone });
  return json({ zone });
});

export const DELETE = route("zones.clear", async (req) => {
  await requireSession(req);
  await clearActiveZone();
  await publish({ type: "zone.updated", zone: null });
  return json({ zone: null });
});
