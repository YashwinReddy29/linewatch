import { EventEmitter } from "node:events";

import type { BusEvent } from "./types";

// One emitter per server process, shared by every route module (survives dev hot reload).
const g = globalThis as unknown as { __lwBus?: EventEmitter };
if (!g.__lwBus) {
  g.__lwBus = new EventEmitter();
  g.__lwBus.setMaxListeners(100);
}
const bus = g.__lwBus;

export function publish(event: BusEvent): void {
  bus.emit("event", event);
}

export function subscribe(listener: (event: BusEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
