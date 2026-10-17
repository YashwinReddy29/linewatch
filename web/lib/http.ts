import { randomUUID } from "node:crypto";

import { log } from "./log";
import { metrics } from "./metrics";

/** An error with an HTTP status and a stable machine-readable code, returned to the client as-is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new ApiError(400, code, message);
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);

/** Every error response has this shape: { error: { code, message, requestId } }. */
export function errorResponse(err: ApiError, requestId: string): Response {
  return Response.json(
    { error: { code: err.code, message: err.message, requestId } },
    { status: err.status, headers: { "Cache-Control": "no-store", ...err.headers } },
  );
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export function requestIdOf(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

type Handler<C> = (req: Request, ctx: C, requestId: string) => Promise<Response>;

/**
 * Wraps a route handler with what every route needs: a request ID (taken from the
 * worker's X-Request-ID when present, so one incident can be followed across both
 * services), one structured log line, a latency histogram, and a consistent error body.
 */
export function route<C = unknown>(name: string, handler: Handler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const requestId = requestIdOf(req);
    const start = performance.now();
    let res: Response;
    try {
      res = await handler(req, ctx, requestId);
    } catch (err) {
      if (err instanceof ApiError) {
        res = errorResponse(err, requestId);
      } else {
        log.error({ err, route: name, requestId }, "unhandled error");
        res = errorResponse(new ApiError(500, "internal", "Something went wrong on the server"), requestId);
      }
    }
    const seconds = (performance.now() - start) / 1000;
    metrics.httpDuration.observe({ route: name, method: req.method, status: String(res.status) }, seconds);
    if (!res.headers.has("x-request-id")) {
      try {
        res.headers.set("x-request-id", requestId);
      } catch {
        /* some responses have immutable headers */
      }
    }
    const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
    log[level]({ route: name, method: req.method, status: res.status, ms: Math.round(seconds * 1000), requestId }, "request");
    return res;
  };
}

/**
 * Reads a JSON body without trusting Content-Length: counts bytes as they arrive and stops
 * at `maxBytes` with a 413, so an oversized or endless body can't exhaust memory.
 */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "payload_too_large", `Body is larger than ${maxBytes} bytes`);
  }
  if (!req.body) throw badRequest("Body must be JSON", "invalid_json");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "payload_too_large", `Body is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("Body must be JSON", "invalid_json");
  }
}
