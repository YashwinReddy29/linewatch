/**
 * Runs once when the server process starts (Next.js instrumentation hook):
 * applies migrations, starts the Roboflow upload loop, and closes connections on SIGTERM.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServer } = await import("./instrumentation-node");
    await startServer();
  }
}
