import { closeAll, incidentBody, params, req, resetDatabase, sessionHeaders, WORKER_AUTH } from "../helpers";

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { POST as ingestRoute } from "@/app/api/incidents/route";
import { POST as reviewRoute } from "@/app/api/incidents/[id]/review/route";
import { POST as retryRoute } from "@/app/api/incidents/[id]/upload/route";
import { claimUpload, getIncident, query } from "@/lib/db";
import { runUploadOnce, type Uploader } from "@/lib/jobs";

async function newIncident(withRaw = true): Promise<string> {
  const body = incidentBody(withRaw ? {} : { rawJpegBase64: null });
  const res = await ingestRoute(req("/api/incidents", { method: "POST", headers: WORKER_AUTH, json: body }), undefined);
  assert.equal(res.status, 201);
  return body.id;
}

async function review(id: string, status: string) {
  return reviewRoute(req(`/api/incidents/${id}/review`, { method: "POST", headers: await sessionHeaders(), json: { status } }), params(id));
}

/** Makes the queued job due now, as if its backoff had elapsed. */
const makeDue = (id: string) => query("UPDATE incidents SET roboflow_next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);

const ok: Uploader = async () => ({ ok: true, imageId: "img-1" });
const flaky: Uploader = async () => ({ ok: false, error: "HTTP 503", retryable: true });
const rejected: Uploader = async () => ({ ok: false, error: "Unknown project", retryable: false });

describe("review + Roboflow upload jobs", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.ROBOFLOW_API_KEY = "key";
    process.env.ROBOFLOW_PROJECT = "proj";
  });
  after(async () => {
    delete process.env.ROBOFLOW_API_KEY;
    delete process.env.ROBOFLOW_PROJECT;
    await closeAll();
  });

  it("needs a session and a valid status", async () => {
    const id = await newIncident();
    const anon = await reviewRoute(req(`/x`, { method: "POST", json: { status: "confirmed" } }), params(id));
    assert.equal(anon.status, 401);
    assert.equal((await review(id, "deleted")).status, 400);
    assert.equal((await review("00000000-0000-4000-8000-000000000000", "confirmed")).status, 404);
  });

  it("confirming never queues an upload", async () => {
    const id = await newIncident();
    const res = await review(id, "confirmed");
    assert.equal(res.status, 200);
    const inc = (await res.json()).incident;
    assert.equal(inc.status, "confirmed");
    assert.equal(inc.roboflowStatus, null);
    assert.ok(inc.reviewedAt);
  });

  it("a false alarm is queued, then uploaded by the loop", async () => {
    const id = await newIncident();
    const inc = (await (await review(id, "false_alarm")).json()).incident;
    assert.equal(inc.roboflowStatus, "queued");
    assert.equal(await runUploadOnce(ok), "uploaded");
    const done = await getIncident(id);
    assert.equal(done?.roboflowStatus, "uploaded");
    assert.equal(done?.roboflowImageId, "img-1");
    assert.equal(done?.roboflowAttempts, 1);
    assert.equal(await runUploadOnce(ok), "idle");
  });

  it("retries a transient failure with backoff, then gives up after the max attempts", async () => {
    const id = await newIncident();
    await review(id, "false_alarm");
    assert.equal(await runUploadOnce(flaky), "retry");
    let inc = await getIncident(id);
    assert.equal(inc?.roboflowStatus, "queued");
    assert.equal(inc?.roboflowAttempts, 1);
    assert.ok(Date.parse(inc!.roboflowNextAttemptAt!) > Date.now(), "next attempt is in the future");
    assert.equal(await runUploadOnce(flaky), "idle", "not due yet");

    await makeDue(id);
    assert.equal(await runUploadOnce(flaky), "retry");
    await makeDue(id);
    assert.equal(await runUploadOnce(flaky), "failed"); // UPLOAD_MAX_ATTEMPTS=3
    inc = await getIncident(id);
    assert.equal(inc?.roboflowStatus, "failed");
    assert.equal(inc?.roboflowAttempts, 3);
    assert.equal(inc?.roboflowError, "HTTP 503");
  });

  it("fails at once when retrying can't help", async () => {
    const id = await newIncident();
    await review(id, "false_alarm");
    assert.equal(await runUploadOnce(rejected), "failed");
    assert.equal((await getIncident(id))?.roboflowAttempts, 1);
  });

  it("fails without calling Roboflow when no clean frame was saved", async () => {
    const id = await newIncident(false);
    await review(id, "false_alarm");
    let called = false;
    assert.equal(await runUploadOnce(async () => ((called = true), { ok: true })), "failed");
    assert.equal(called, false);
    assert.match((await getIncident(id))!.roboflowError!, /No clean frame/);
  });

  it("manual retry requeues a failed upload with a fresh budget", async () => {
    const id = await newIncident();
    await review(id, "false_alarm");
    await runUploadOnce(rejected);
    const headers = await sessionHeaders();
    const res = await retryRoute(req(`/x`, { method: "POST", headers }), params(id));
    assert.equal(res.status, 202);
    const inc = (await res.json()).incident;
    assert.equal(inc.roboflowStatus, "queued");
    assert.equal(inc.roboflowAttempts, 0);
    // Not failed any more, so a second retry is a conflict.
    assert.equal((await retryRoute(req(`/x`, { method: "POST", headers }), params(id))).status, 409);
  });

  it("un-marking a queued false alarm cancels its upload", async () => {
    const id = await newIncident();
    await review(id, "false_alarm");
    const inc = (await (await review(id, "confirmed")).json()).incident;
    assert.equal(inc.roboflowStatus, null);
    assert.equal(await runUploadOnce(ok), "idle");
  });

  it("an upload whose process died is claimed again after its lease expires", async () => {
    const id = await newIncident();
    await review(id, "false_alarm");
    const claimed = await claimUpload(60);
    assert.equal(claimed?.id, id);
    assert.equal(await claimUpload(60), null, "lease still held");
    await query("UPDATE incidents SET roboflow_locked_until = now() - interval '1 second' WHERE id = $1", [id]);
    assert.equal(await runUploadOnce(ok), "uploaded");
    assert.equal((await getIncident(id))?.roboflowAttempts, 2);
  });

  it("concurrent claimers never take the same job", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => newIncident()));
    for (const id of ids) await review(id, "false_alarm");
    const claims = await Promise.all(Array.from({ length: 20 }, () => claimUpload(60)));
    const got = claims.filter(Boolean).map((c) => c!.id);
    assert.equal(got.length, 10);
    assert.equal(new Set(got).size, 10);
  });

  it("without Roboflow configured, a false alarm is marked skipped", async () => {
    delete process.env.ROBOFLOW_API_KEY;
    const id = await newIncident();
    const inc = (await (await review(id, "false_alarm")).json()).incident;
    assert.equal(inc.roboflowStatus, "skipped");
    assert.equal(await runUploadOnce(ok), "idle");
  });
});

describe("review changed while an upload is in flight", () => {
  after(closeAll);

  it("a failed upload for an incident no longer marked false alarm is dropped, not retried", async () => {
    await resetDatabase();
    process.env.ROBOFLOW_API_KEY = "key";
    process.env.ROBOFLOW_PROJECT = "proj";
    try {
      const id = await newIncident();
      await review(id, "false_alarm");
      const slow: Uploader = async () => {
        await review(id, "confirmed"); // supervisor changes their mind mid-upload
        return { ok: false, error: "HTTP 503", retryable: true };
      };
      assert.equal(await runUploadOnce(slow), "retry");
      const inc = await getIncident(id);
      assert.equal(inc?.status, "confirmed");
      assert.equal(inc?.roboflowStatus, null);
      assert.equal(await runUploadOnce(ok), "idle");
    } finally {
      delete process.env.ROBOFLOW_API_KEY;
      delete process.env.ROBOFLOW_PROJECT;
    }
  });
});
