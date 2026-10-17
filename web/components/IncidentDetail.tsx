"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { STATUS_LABEL, exactTime, incidentTitle, percent, relativeTime, seconds } from "@/lib/format";
import type { Incident } from "@/lib/types";

import { Header } from "./Header";
import { ReviewActions } from "./ReviewActions";
import { useLive } from "./useLive";

export function IncidentDetail({ id }: { id: string }) {
  const { status, statusError, incidents, upsert } = useLive();
  const [fetched, setFetched] = useState<Incident | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [view, setView] = useState<"annotated" | "raw">("annotated");

  useEffect(() => {
    fetch(`/api/incidents/${id}`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 404) return setState("missing");
        if (!res.ok) throw new Error();
        setFetched(((await res.json()) as { incident: Incident }).incident);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [id]);

  // Live updates (review from another tab, Roboflow upload finishing) arrive through useLive.
  const incident = incidents?.find((i) => i.id === id) ?? fetched;

  return (
    <>
      <Header status={status} statusError={statusError} />
      <main className="detail">
        <Link href="/" className="back">
          Back to live view
        </Link>

        {state === "loading" && !incident && <p className="muted">Loading incident</p>}
        {state === "missing" && (
          <div className="empty">
            <p className="empty-title">This incident doesn&apos;t exist.</p>
            <p>It may have been recorded by a different database. Go back to the live view to see current incidents.</p>
          </div>
        )}
        {state === "error" && !incident && (
          <p className="inline-error" role="alert">
            Couldn&apos;t load this incident. Check that the console server is running, then reload.
          </p>
        )}

        {incident && (
          <div className="detail-grid">
            <div>
              <div className="detail-image">
                {incident.hasSnapshot || incident.hasRaw ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/incidents/${incident.id}/snapshot${view === "raw" ? "?kind=raw" : ""}`}
                    alt={
                      view === "raw"
                        ? "Clean camera frame at the moment of the incident"
                        : "Camera frame with detections at the moment of the incident"
                    }
                  />
                ) : (
                  <div className="stream-blank">No snapshot was saved for this incident.</div>
                )}
              </div>
              {incident.hasRaw && (
                <div className="segmented" role="group" aria-label="Snapshot view">
                  <button aria-pressed={view === "annotated"} onClick={() => setView("annotated")}>
                    With detections
                  </button>
                  <button aria-pressed={view === "raw"} onClick={() => setView("raw")}>
                    Clean frame
                  </button>
                </div>
              )}
            </div>

            <aside className={`detail-side status-${incident.status}`}>
              <p className="detail-status">{STATUS_LABEL[incident.status]}</p>
              <h1>{incidentTitle(incident.zoneName)}</h1>
              <p className="muted">
                <time dateTime={incident.triggeredAt}>{exactTime(incident.triggeredAt)}</time> (
                {relativeTime(incident.triggeredAt)})
              </p>

              <ReviewActions
                incident={incident}
                roboflowConfigured={status?.roboflowConfigured ?? false}
                projectUrl={status?.roboflowProjectUrl}
                onChange={upsert}
              />

              <dl className="facts">
                <div>
                  <dt>Person</dt>
                  <dd>#{incident.trackerId}</dd>
                </div>
                <div>
                  <dt>Without a vest for</dt>
                  <dd>{seconds(incident.durationS)} before the alert</dd>
                </div>
                <div>
                  <dt>Why it fired</dt>
                  <dd>
                    No vest detected in {incident.violatingFrames} of the last {incident.windowFrames} frames while
                    inside the zone
                  </dd>
                </div>
                <div>
                  <dt>Person detection confidence</dt>
                  <dd>{percent(incident.confidence)}</dd>
                </div>
                {incident.reviewedAt && (
                  <div>
                    <dt>Reviewed</dt>
                    <dd>{exactTime(incident.reviewedAt)}</dd>
                  </div>
                )}
              </dl>
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
