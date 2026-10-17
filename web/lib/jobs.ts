/**
 * Background delivery of false-alarm frames to Roboflow.
 *
 * A review never waits on Roboflow: it marks the incident `queued` in the same UPDATE.
 * This loop claims due jobs from Postgres, uploads, and records the outcome. A process that
 * dies mid-upload leaves an expired lease, and the job is claimed again — so delivery is
 * at-least-once. Roboflow reports re-sent images as duplicates, which we count as success.
 */
import { claimUpload, completeUpload, failUpload } from "./db";
import { publish } from "./bus";
import { env } from "./env";
import { log } from "./log";
import { metrics } from "./metrics";
import { uploadFalseAlarm, type UploadResult } from "./roboflow";
import { readSnapshot } from "./storage";
import type { Incident } from "./types";

export const LEASE_SECONDS = 60;

export type Uploader = (imageName: string, jpeg: Buffer) => Promise<UploadResult>;

/** Exponential backoff with ±50% jitter so many failed jobs don't retry in lockstep. */
export function backoffMs(attempt: number, baseMs: number, random = Math.random): number {
  return Math.round(baseMs * 2 ** Math.max(0, attempt - 1) * (0.5 + random()));
}

export function imageNameFor(incident: Incident): string {
  return `linewatch_${incident.triggeredAt.replace(/[:.]/g, "-")}_${incident.id}.jpg`;
}

/** Processes at most one job. Returns what happened, for tests and logs. */
export async function runUploadOnce(upload: Uploader = uploadFalseAlarm): Promise<"idle" | "uploaded" | "retry" | "failed"> {
  const job = await claimUpload(LEASE_SECONDS);
  if (!job) return "idle";
  await publish({ type: "incident.updated", incident: job });

  // Only the clean frame is ever sent: boxes drawn on an image would poison a training set.
  const jpeg = await readSnapshot(job.id, "raw");
  const result: UploadResult = jpeg
    ? await upload(imageNameFor(job), jpeg)
    : { ok: false, error: "No clean frame was saved for this incident", retryable: false };

  let outcome: "uploaded" | "retry" | "failed";
  let updated: Incident | null;
  if (result.ok) {
    outcome = "uploaded";
    updated = await completeUpload(job.id, result.imageId ?? null);
  } else if (result.retryable !== false && job.roboflowAttempts < env.uploadMaxAttempts()) {
    outcome = "retry";
    updated = await failUpload(job.id, result.error ?? "Upload failed", backoffMs(job.roboflowAttempts, env.uploadBackoffMs()));
  } else {
    outcome = "failed";
    updated = await failUpload(job.id, result.error ?? "Upload failed", null);
  }
  metrics.uploads.inc({ result: outcome });
  log[outcome === "uploaded" ? "info" : "warn"](
    { incidentId: job.id, attempt: job.roboflowAttempts, outcome, error: result.error },
    "roboflow upload",
  );
  if (updated) await publish({ type: "incident.updated", incident: updated });
  return outcome;
}

const g = globalThis as unknown as { __lwJobs?: { timer: NodeJS.Timeout; running: boolean } };

/** Polls every `intervalMs`; drains all due jobs on each tick. One loop per process. */
export function startUploadLoop(intervalMs = 2000): void {
  if (g.__lwJobs || !env.jobsEnabled()) return;
  const state = { running: false, timer: undefined as unknown as NodeJS.Timeout };
  state.timer = setInterval(async () => {
    if (state.running) return;
    state.running = true;
    try {
      while ((await runUploadOnce()) !== "idle") {
        /* keep draining */
      }
    } catch (err) {
      log.error({ err }, "upload loop error");
    } finally {
      state.running = false;
    }
  }, intervalMs);
  state.timer.unref();
  g.__lwJobs = state;
  log.info({ intervalMs }, "upload loop started");
}

export function stopUploadLoop(): void {
  if (g.__lwJobs) clearInterval(g.__lwJobs.timer);
  g.__lwJobs = undefined;
}
