import type { IncidentStatus } from "./types";

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function exactTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function seconds(value: number): string {
  return value < 10 ? `${value.toFixed(1)} s` : `${Math.round(value)} s`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "Needs review",
  confirmed: "Confirmed",
  false_alarm: "False alarm",
};

export function incidentTitle(zoneName: string | null): string {
  return zoneName ? `No vest in ${zoneName}` : "No vest in the monitored zone";
}
