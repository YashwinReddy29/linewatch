import {
  clearLoginFailures,
  clientAddress,
  createSessionToken,
  loginBlockedFor,
  recordLoginFailure,
  secretsEqual,
  sessionCookie,
} from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiError, json, readJson, route } from "@/lib/http";
import { metrics } from "@/lib/metrics";
import { loginIn, parse } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/auth/login { password } -> sets the HttpOnly session cookie. */
export const POST = route("auth.login", async (req) => {
  if (env.authDisabled()) return json({ ok: true, authEnabled: false });
  if (!env.adminPassword() || env.sessionSecret().length < 32) {
    throw new ApiError(503, "not_configured", "ADMIN_PASSWORD and SESSION_SECRET must be set on the web app");
  }
  const address = clientAddress(req);
  const wait = loginBlockedFor(address);
  if (wait > 0) {
    metrics.loginAttempts.inc({ result: "rate_limited" });
    throw new ApiError(429, "too_many_attempts", `Too many wrong passwords. Try again in ${wait} s`, {
      "Retry-After": String(wait),
    });
  }
  const { password } = parse(loginIn, await readJson(req, 4096));
  if (!(await secretsEqual(password, env.adminPassword()))) {
    recordLoginFailure(address);
    metrics.loginAttempts.inc({ result: "wrong_password" });
    throw new ApiError(401, "wrong_password", "Wrong password");
  }
  clearLoginFailures(address);
  metrics.loginAttempts.inc({ result: "ok" });
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await createSessionToken()) });
});
