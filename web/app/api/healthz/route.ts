import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Liveness: the process is up and serving. Checks nothing else, so a DB outage doesn't restart it. */
export const GET = route("healthz", async () => json({ status: "ok" }));
