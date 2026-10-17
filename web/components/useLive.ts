"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BusEvent, Incident, StatusResponse, Zone } from "@/lib/types";

import { apiFetch, errorMessage } from "./api";

export type Connection = "connecting" | "live" | "reconnecting";

/**
 * Live data for the console: status is polled (worker FPS, health), incidents and zone
 * changes are pushed over server-sent events so new incidents appear without a refresh.
 */
export function useLive() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const mounted = useRef(true);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(errorMessage(await res.json().catch(() => null), res.status));
      const body = (await res.json()) as StatusResponse;
      if (mounted.current) {
        setStatus(body);
        setStatusError(null);
      }
    } catch (err) {
      if (mounted.current) setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadIncidents = useCallback(async () => {
    try {
      // Newest 200; older incidents stay reachable through the paginated API.
      const res = await apiFetch("/api/incidents?status=all&limit=200", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { incidents: Incident[] };
      if (mounted.current) setIncidents(body.incidents);
    } catch {
      if (mounted.current) setIncidents((prev) => prev ?? []);
    }
  }, []);

  const upsert = useCallback((incident: Incident) => {
    setIncidents((prev) => {
      const list = prev ?? [];
      const i = list.findIndex((x) => x.id === incident.id);
      if (i === -1) return [incident, ...list];
      const next = list.slice();
      next[i] = incident;
      return next;
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Both loaders set state only after their fetch resolves (asynchronously), which is
    // the "subscribe to an external system" case the rule allows; it can't see past the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStatus();
    loadIncidents();
    const poll = setInterval(loadStatus, 3000);

    const source = new EventSource("/api/events");
    source.onopen = () => {
      setConnection("live");
      loadIncidents(); // catch up on anything missed while disconnected
    };
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as BusEvent;
      if (event.type === "incident.created") {
        upsert(event.incident);
        setFreshIds((s) => new Set(s).add(event.incident.id));
        setTimeout(() => {
          setFreshIds((s) => {
            const next = new Set(s);
            next.delete(event.incident.id);
            return next;
          });
        }, 2400);
        loadStatus();
      } else if (event.type === "incident.updated") {
        upsert(event.incident);
        loadStatus();
      } else if (event.type === "zone.updated") {
        setStatus((s) => (s ? { ...s, zone: event.zone as Zone | null } : s));
      }
    };

    return () => {
      mounted.current = false;
      clearInterval(poll);
      source.close();
    };
  }, [loadStatus, loadIncidents, upsert]);

  return { status, statusError, incidents, connection, freshIds, upsert, refresh: loadStatus };
}

export async function reviewIncident(id: string, status: Incident["status"]): Promise<Incident> {
  const res = await apiFetch(`/api/incidents/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Couldn't save the review: ${errorMessage(body, res.status)}`);
  return body.incident as Incident;
}

export async function retryUpload(id: string): Promise<Incident> {
  const res = await apiFetch(`/api/incidents/${id}/upload`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Retry failed: ${errorMessage(body, res.status)}`);
  return body.incident as Incident;
}
