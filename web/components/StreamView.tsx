"use client";

import { useEffect, useState } from "react";

import type { WorkerHealth } from "@/lib/types";

type View = "loading" | "playing" | "lost";

/** The annotated live view from the worker (MJPEG in a plain img tag). */
export function StreamView({ url, worker }: { url: string | undefined; worker: WorkerHealth | undefined }) {
  const [view, setView] = useState<View>("loading");
  const [attempt, setAttempt] = useState(0);

  // When the stream drops, keep the last frame on screen and try again every few seconds.
  useEffect(() => {
    if (view !== "lost") return;
    const t = setTimeout(() => {
      setView("loading");
      setAttempt((a) => a + 1);
    }, 3000);
    return () => clearTimeout(t);
  }, [view]);

  const workerDown = worker && (worker.state === "offline" || worker.state === "error");
  const warming = worker && (worker.state === "loading_model" || worker.state === "starting" || worker.state === "connecting");

  let overlay: string | null = null;
  if (worker?.state === "offline") overlay = "No camera feed. The camera worker isn't running.";
  else if (workerDown) overlay = worker.message;
  else if (warming) overlay = worker.message || "Starting the camera worker";
  else if (view === "loading") overlay = "Connecting to the camera";
  else if (view === "lost") overlay = "Camera feed paused. Reconnecting";

  return (
    <figure className="stream" aria-label="Live camera with detections">
      {url && !workerDown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={attempt}
          src={`${url}?a=${attempt}`}
          alt="Live camera feed with detected people, vests and the monitored zone"
          onLoad={() => setView("playing")}
          onError={() => setView("lost")}
        />
      ) : (
        <div className="stream-blank" />
      )}
      {overlay && (
        <figcaption className={`stream-overlay ${workerDown ? "is-down" : ""}`}>
          {!workerDown && <span className="spinner" aria-hidden="true" />}
          <span>{overlay}</span>
        </figcaption>
      )}
    </figure>
  );
}

export function StreamStats({ worker }: { worker: WorkerHealth | undefined }) {
  if (!worker || worker.state !== "running") return null;
  return (
    <dl className="stats">
      <div>
        <dt>Processing</dt>
        <dd>{worker.fps?.toFixed(1) ?? "–"} fps</dd>
      </div>
      <div>
        <dt>Model time per frame</dt>
        <dd>{worker.infer_ms != null ? Math.round(worker.infer_ms) : "–"} ms</dd>
      </div>
      <div>
        <dt>Incidents this run</dt>
        <dd>{worker.incidents ?? 0}</dd>
      </div>
    </dl>
  );
}
