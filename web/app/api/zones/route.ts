import { publish } from "@/lib/bus";
import { clearActiveZone, getActiveZone, saveActiveZone } from "@/lib/db";
import { json, problem } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return json({ zone: await getActiveZone() });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { name?: unknown; points?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const points = body?.points;
  if (!name) return problem("Give the zone a name, for example Loading bay 2", 400);
  if (name.length > 60) return problem("Zone names can be up to 60 characters", 400);
  const valid =
    Array.isArray(points) &&
    points.length >= 3 &&
    points.length <= 50 &&
    points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1),
    );
  if (!valid) return problem("A zone needs 3 to 50 points, each between 0 and 1", 400);

  const zone = await saveActiveZone(name, points as [number, number][]);
  publish({ type: "zone.updated", zone });
  return json({ zone });
}

export async function DELETE() {
  await clearActiveZone();
  publish({ type: "zone.updated", zone: null });
  return json({ zone: null });
}
