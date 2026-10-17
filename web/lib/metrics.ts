import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** One registry per process, kept on globalThis so dev hot reload doesn't register metrics twice. */
function build() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "linewatch_web_" });

  const httpDuration = new Histogram({
    name: "linewatch_http_request_duration_seconds",
    help: "HTTP request duration by route and status code",
    labelNames: ["route", "method", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const incidentsIngested = new Counter({
    name: "linewatch_incidents_ingested_total",
    help: "Incident POSTs from the worker, by result (created, duplicate)",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const reviews = new Counter({
    name: "linewatch_reviews_total",
    help: "Review decisions saved, by status",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  const uploads = new Counter({
    name: "linewatch_roboflow_uploads_total",
    help: "Roboflow upload attempts, by result (uploaded, retry, failed, cancelled)",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const loginAttempts = new Counter({
    name: "linewatch_login_attempts_total",
    help: "Console login attempts, by result (ok, wrong_password, rate_limited)",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const sseClients = new Gauge({
    name: "linewatch_sse_clients",
    help: "Open server-sent-event connections on this process",
    registers: [registry],
  });
  return { registry, httpDuration, incidentsIngested, reviews, uploads, loginAttempts, sseClients };
}

const g = globalThis as unknown as { __lwMetrics?: ReturnType<typeof build> };
export const metrics = g.__lwMetrics ?? (g.__lwMetrics = build());
