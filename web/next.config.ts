import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a small self-contained server for the Docker image.
  output: "standalone",
  // pg is a native-ish Node package; keep it out of the bundler.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
