import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Next.js inlines small bootstrap scripts, so script-src needs 'unsafe-inline' (no nonces
 * here); dev mode also needs 'unsafe-eval' for fast refresh. Everything is same-origin:
 * the live stream and snapshots are proxied through this app.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Produces a small self-contained server for the Docker image.
  output: "standalone",
  // pg and pino are Node packages; keep them out of the bundler.
  serverExternalPackages: ["pg", "pino", "prom-client"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
