import { clearedSessionCookie } from "@/lib/auth";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route("auth.logout", async () => json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() }));
