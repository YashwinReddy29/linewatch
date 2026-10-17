"use client";

import { useState } from "react";

import type { Incident } from "@/lib/types";

import { retryUpload, reviewIncident } from "./useLive";

export function ReviewActions({
  incident,
  roboflowConfigured,
  projectUrl,
  onChange,
  showHints = false,
}: {
  incident: Incident;
  roboflowConfigured: boolean;
  projectUrl?: string | null;
  onChange: (incident: Incident) => void;
  showHints?: boolean;
}) {
  const [busy, setBusy] = useState<Incident["status"] | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(status: Incident["status"]) {
    setBusy(status);
    setError(null);
    try {
      onChange(await reviewIncident(incident.id, status));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy("retry");
    setError(null);
    try {
      onChange(await retryUpload(incident.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="review">
      {incident.status === "open" ? (
        <div className="review-buttons">
          <button className="btn btn-confirm" onClick={() => run("confirmed")} disabled={busy !== null}>
            {busy === "confirmed" ? "Saving" : "Confirm incident"}
            {showHints && <kbd>C</kbd>}
          </button>
          <button className="btn btn-quiet" onClick={() => run("false_alarm")} disabled={busy !== null}>
            {busy === "false_alarm" ? "Saving" : "Mark as false alarm"}
            {showHints && <kbd>F</kbd>}
          </button>
        </div>
      ) : (
        <div className="review-done">
          <span>{incident.status === "confirmed" ? "Confirmed as a real incident." : "Marked as a false alarm."}</span>
          <button className="btn-link" onClick={() => run("open")} disabled={busy !== null}>
            {busy === "open" ? "Reopening" : "Reopen"}
          </button>
        </div>
      )}

      {incident.status === "false_alarm" && (
        <RoboflowLine
          incident={incident}
          configured={roboflowConfigured}
          projectUrl={projectUrl}
          retrying={busy === "retry"}
          onRetry={retry}
        />
      )}

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function RoboflowLine({
  incident,
  configured,
  projectUrl,
  retrying,
  onRetry,
}: {
  incident: Incident;
  configured: boolean;
  projectUrl?: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  switch (incident.roboflowStatus) {
    case "uploading":
      return <p className="rf rf-busy">Sending the clean frame to Roboflow for relabeling</p>;
    case "uploaded":
      return (
        <p className="rf rf-ok">
          Sent to Roboflow for relabeling.{" "}
          {projectUrl && (
            <a href={projectUrl} target="_blank" rel="noreferrer">
              Open the dataset
            </a>
          )}
        </p>
      );
    case "failed":
      return (
        <p className="rf rf-fail">
          Not sent to Roboflow: {incident.roboflowError}.{" "}
          <button className="btn-link" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying" : "Retry"}
          </button>
        </p>
      );
    case "skipped":
      return (
        <p className="rf">
          Not sent to Roboflow. Set ROBOFLOW_PROJECT in .env to collect false alarms for relabeling.
        </p>
      );
    default:
      return configured ? <p className="rf rf-busy">Queued for Roboflow</p> : null;
  }
}
