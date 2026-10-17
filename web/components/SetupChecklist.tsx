"use client";

import Link from "next/link";

import type { StatusResponse } from "@/lib/types";

type StepState = "done" | "now" | "later";

/** First-run guide. Shown until the worker is running and a zone exists. */
export function SetupChecklist({ status }: { status: StatusResponse | null }) {
  if (!status) return null;
  const { worker, zone } = status;
  const workerUp = worker.state !== "offline";
  const modelsReady = worker.state === "running";
  if (modelsReady && zone) return null;

  const steps: { state: StepState; title: string; body: React.ReactNode }[] = [
    {
      state: workerUp && worker.state !== "error" ? "done" : "now",
      title: "Start the camera worker",
      body:
        worker.state === "offline" ? (
          <>
            Run <code>docker compose up</code> to start everything, or <code>make worker</code> to start just the
            worker.
          </>
        ) : worker.state === "error" ? (
          worker.message
        ) : (
          "Connected."
        ),
    },
    {
      state: modelsReady ? "done" : workerUp ? "now" : "later",
      title: "Load the models",
      body: modelsReady
        ? "Ready."
        : worker.state === "loading_model"
          ? "Downloading model weights. This happens once and takes about a minute."
          : "Starts automatically once the worker reaches the Inference server.",
    },
    {
      state: zone ? "done" : modelsReady ? "now" : "later",
      title: "Draw the zone to watch",
      body: zone ? (
        `Watching ${zone.name}.`
      ) : (
        <>
          Outline the area where vests are required, like a loading bay or forklift aisle.{" "}
          <Link href="/zones">Draw a zone</Link>
        </>
      ),
    },
  ];

  return (
    <section className="setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up monitoring</h2>
      <ol>
        {steps.map((s) => (
          <li key={s.title} className={`step step-${s.state}`}>
            <span className="step-mark" aria-hidden="true">
              {s.state === "done" ? "✓" : ""}
            </span>
            <span>
              <strong>{s.title}</strong>
              <span className="step-body">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
