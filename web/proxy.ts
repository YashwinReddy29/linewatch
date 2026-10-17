import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Pages only: send signed-out visitors to /login. API routes check auth themselves
 * (lib/auth.ts), so a misconfigured matcher here can never open an endpoint.
 */
export async function proxy(req: NextRequest) {
  if (process.env.AUTH_DISABLED === "true") return NextResponse.next();
  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = req.nextUrl.pathname === "/" ? "" : `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/zones", "/incidents/:path*"],
};
