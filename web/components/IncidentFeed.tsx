"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { STATUS_LABEL, exactTime, incidentTitle, percent, relativeTime, seconds } from "@/lib/format";
import type { Counts, Incident, IncidentStatus } from "@/lib/types";

import { ReviewActions } from "./ReviewActions";
import { reviewIncident } from "./useLive";

type Filter = IncidentStatus | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Needs review" },
  { key: "confirmed", label: "Confirmed" },
  { key: "false_alarm", label: "False alarms" },
  { key: "all", label: "All" },
];

export function IncidentFeed({
  incidents,
  counts,
  freshIds,
  roboflowConfigured,
  projectUrl,
  monitoring,
  onChange,
}: {
  incidents: Incident[] | null;
  counts: Counts | undefined;
  freshIds: Set<string>;
  roboflowConfigured: boolean;
  projectUrl: string | null;
  monitoring: boolean;
  onChange: (incident: Incident) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, tick] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  // Re-render every 20 s so "2 min ago" stays true.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(
    () => (incidents ?? []).filter((i) => filter === "all" || i.status === filter),
    [incidents, filter],
  );
  const selected = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null;

  // Keyboard review: J/K move, C confirm, F false alarm.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const index = selected ? visible.findIndex((i) => i.id === selected.id) : -1;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "arrowdown") {
        const next = visible[Math.min(visible.length - 1, index + 1)];
        if (next) setSelectedId(next.id);
        e.preventDefault();
      } else if (key === "k" || key === "arrowup") {
        const prev = visible[Math.max(0, index - 1)];
        if (prev) setSelectedId(prev.id);
        e.preventDefault();
      } else if ((key === "c" || key === "f") && selected && selected.status === "open") {
        const status = key === "c" ? "confirmed" : "false_alarm";
        // Move the selection to the next item so a reviewer can work through the queue.
        const after = visible[index + 1] ?? visible[index - 1];
        if (filter === "open" && after) setSelectedId(after.id);
        reviewIncident(selected.id, status).then(onChange).catch(() => {});
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected, filter, onChange]);

  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-id="${selected.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <section className="feed" aria-labelledby="feed-title">
      <div className="feed-head">
        <h2 id="feed-title">Incidents</h2>
        <p className="keys" aria-hidden="true">
          <span>
            <kbd>J</kbd>
            <kbd>K</kbd> move
          </span>
          <span>
            <kbd>C</kbd> confirm
          </span>
          <span>
            <kbd>F</kbd> false alarm
          </span>
        </p>
      </div>

      <div className="tabs" role="tablist" aria-label="Filter incidents">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className="tab"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="count">{counts ? counts[f.key] : ""}</span>
          </button>
        ))}
      </div>

      {incidents === null ? (
        <ol className="feed-list" aria-busy="true">
          {[0, 1, 2].map((n) => (
            <li key={n} className="row skeleton">
              <span className="thumb" />
              <span className="lines">
                <span />
                <span />
              </span>
            </li>
          ))}
        </ol>
      ) : visible.length === 0 ? (
        <EmptyFeed filter={filter} monitoring={monitoring} hasAny={(incidents ?? []).length > 0} onShowAll={() => setFilter("all")} />
      ) : (
        <ol className="feed-list" ref={listRef}>
          {visible.map((incident) => {
            const isSelected = selected?.id === incident.id;
            return (
              <li
                key={incident.id}
                data-id={incident.id}
                className={`row status-${incident.status} ${isSelected ? "is-selected" : ""} ${
                  freshIds.has(incident.id) ? "is-fresh" : ""
                }`}
              >
                <button className="row-main" onClick={() => setSelectedId(incident.id)} aria-pressed={isSelected}>
                  {incident.hasSnapshot ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="thumb" src={`/api/incidents/${incident.id}/snapshot`} alt="" loading="lazy" />
                  ) : (
                    <span className="thumb" />
                  )}
                  <span className="lines">
                    <span className="title">{incidentTitle(incident.zoneName)}</span>
                    <span className="meta">
                      <time dateTime={incident.triggeredAt} title={exactTime(incident.triggeredAt)}>
                        {relativeTime(incident.triggeredAt)}
                      </time>
                      <span>person #{incident.trackerId}</span>
                      <span>{seconds(incident.durationS)} without a vest</span>
                    </span>
                  </span>
                  {incident.status !== "open" && <span className="chip">{STATUS_LABEL[incident.status]}</span>}
                </button>
                {isSelected && (
                  <div className="row-detail">
                    <p className="why">
                      In the zone with no vest detected in {incident.violatingFrames} of the last{" "}
                      {incident.windowFrames} frames. Person detected with {percent(incident.confidence)} confidence.
                    </p>
                    <ReviewActions
                      incident={incident}
                      roboflowConfigured={roboflowConfigured}
                      projectUrl={projectUrl}
                      onChange={onChange}
                    />
                    <Link href={`/incidents/${incident.id}`} className="btn-link">
                      Open full incident
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function EmptyFeed({
  filter,
  monitoring,
  hasAny,
  onShowAll,
}: {
  filter: Filter;
  monitoring: boolean;
  hasAny: boolean;
  onShowAll: () => void;
}) {
  if (filter === "open") {
    return (
      <div className="empty">
        <p className="empty-title">{hasAny ? "All caught up." : "No incidents yet."}</p>
        <p>
          {monitoring
            ? "When someone enters the zone without a vest, it appears here within a few seconds."
            : "Incidents appear here once the camera worker is running and a zone is drawn."}
        </p>
        {hasAny && (
          <button className="btn-link" onClick={onShowAll}>
            Show reviewed incidents
          </button>
        )}
      </div>
    );
  }
  const what = filter === "confirmed" ? "confirmed incidents" : filter === "false_alarm" ? "false alarms" : "incidents";
  return (
    <div className="empty">
      <p className="empty-title">No {what}.</p>
      {filter === "false_alarm" && <p>False alarms you mark are sent to Roboflow so the model can learn from them.</p>}
    </div>
  );
}
