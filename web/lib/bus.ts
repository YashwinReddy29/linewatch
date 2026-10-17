/**
 * Live updates for every open console tab, across any number of web processes.
 *
 * publish() sends a Postgres NOTIFY; each process holds one LISTEN connection and fans
 * events out to its own SSE clients. NOTIFY is fire-and-forget: a tab that was offline
 * catches up by refetching the list when its EventSource reconnects (see useLive.ts).
 */
import { EventEmitter } from "node:events";

import { Client } from "pg";

import { env } from "./env";
import { log } from "./log";
import { pool, ready } from "./db";
import type { BusEvent } from "./types";

const CHANNEL = "linewatch_events";
const MAX_PAYLOAD = 7900; // Postgres NOTIFY limit is 8000 bytes

interface BusState {
  emitter: EventEmitter;
  client?: Client;
  starting?: Promise<void>;
  retryMs: number;
  stopped: boolean;
}

const g = globalThis as unknown as { __lwBus?: BusState };
const state: BusState =
  g.__lwBus ?? (g.__lwBus = { emitter: new EventEmitter().setMaxListeners(1000), retryMs: 500, stopped: false });

export async function publish(event: BusEvent): Promise<void> {
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
    log.warn({ type: event.type, bytes: Buffer.byteLength(payload) }, "event too large for NOTIFY; skipped");
    return;
  }
  try {
    await ready();
    await pool().query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
  } catch (err) {
    // A missed live update is recoverable (tabs refetch); never fail the request over it.
    log.warn({ err, type: event.type }, "publish failed");
  }
}

function connect(): Promise<void> {
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const client = new Client({ connectionString: env.databaseUrl() });
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        state.emitter.emit("event", JSON.parse(msg.payload) as BusEvent);
      } catch (err) {
        log.warn({ err }, "bad NOTIFY payload");
      }
    });
    const reconnect = (why: string) => {
      if (state.client !== client) return;
      state.client = undefined;
      state.starting = undefined;
      client.removeAllListeners();
      client.end().catch(() => undefined);
      if (state.stopped) return;
      const wait = state.retryMs;
      state.retryMs = Math.min(state.retryMs * 2, 30_000);
      log.warn({ why, retryInMs: wait }, "event listener disconnected");
      setTimeout(() => void connect().catch(() => undefined), wait).unref();
    };
    client.on("error", (err) => reconnect(err.message));
    client.on("end", () => reconnect("connection ended"));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      state.client = client;
      reconnect(err instanceof Error ? err.message : String(err));
      throw err;
    }
    state.client = client;
    state.retryMs = 500;
  })();
  return state.starting;
}

/** Resolves once this process is listening, so a subscriber never misses events published after it. */
export async function subscribe(listener: (event: BusEvent) => void): Promise<() => void> {
  state.stopped = false;
  state.emitter.on("event", listener);
  try {
    await connect();
  } catch {
    /* reconnect loop is already running; the listener stays registered */
  }
  return () => state.emitter.off("event", listener);
}

/** For tests and graceful shutdown. */
export async function closeBus(): Promise<void> {
  state.stopped = true;
  const client = state.client;
  state.client = undefined;
  state.starting = undefined;
  if (client) {
    client.removeAllListeners();
    await client.end().catch(() => undefined);
  }
}
