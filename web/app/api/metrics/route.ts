import { secretsEqual } from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiError, route } from "@/lib/http";
import { metrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Prometheus scrape endpoint. Disabled unless METRICS_TOKEN is set; then `Authorization: Bearer <token>`. */
export const GET = route("metrics", async (req) => {
  const token = env.metricsToken();
  if (!token) throw new ApiError(404, "not_found", "Metrics are disabled (set METRICS_TOKEN)");
  const header = req.headers.get("authorization") ?? "";
  if (!(await secretsEqual(header.startsWith("Bearer ") ? header.slice(7) : "", token))) {
    throw new ApiError(401, "bad_metrics_token", "Invalid metrics token");
  }
  return new Response(await metrics.registry.metrics(), {
    headers: { "Content-Type": metrics.registry.contentType, "Cache-Control": "no-store" },
  });
});
