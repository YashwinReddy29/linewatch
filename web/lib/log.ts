import pino from "pino";

import { env } from "./env";

const g = globalThis as unknown as { __lwLog?: pino.Logger };

/** JSON logs to stdout, one object per line. Secrets are redacted by key name. */
export const log: pino.Logger =
  g.__lwLog ??
  (g.__lwLog = pino({
    level: process.env.NODE_ENV === "test" ? "silent" : env.logLevel(),
    base: { service: "web" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["password", "token", "apiKey", "*.password", "*.token", "*.apiKey", "headers.authorization", "headers.cookie"],
      censor: "[redacted]",
    },
  }));
