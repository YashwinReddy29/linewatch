import "../helpers";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "@/lib/http";
import { backoffMs } from "@/lib/jobs";
import { incidentIn, listQuery, parse, zoneIn } from "@/lib/validation";
import { incidentBody } from "../helpers";

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    return err.message;
  }
  assert.fail("expected a validation error");
}

describe("incident validation", () => {
  it("accepts what the worker sends", () => {
    assert.ok(parse(incidentIn, incidentBody()));
  });

  it("names the bad field", () => {
    assert.match(message(() => parse(incidentIn, incidentBody({ id: "not-a-uuid" }))), /^id:/);
    assert.match(message(() => parse(incidentIn, incidentBody({ confidence: 1.5 }))), /^confidence:/);
    assert.match(message(() => parse(incidentIn, incidentBody({ bbox: [0, 0, 1] }))), /^bbox/);
    assert.match(message(() => parse(incidentIn, incidentBody({ violatingFrames: 7, windowFrames: 6 }))), /violatingFrames/);
    assert.match(message(() => parse(incidentIn, incidentBody({ triggeredAt: "yesterday" }))), /^triggeredAt:/);
    assert.match(message(() => parse(incidentIn, incidentBody({ rawJpegBase64: "not base64!" }))), /^rawJpegBase64:/);
  });

  it("rejects startedAt after triggeredAt", () => {
    const now = Date.now();
    const body = incidentBody({ startedAt: new Date(now).toISOString(), triggeredAt: new Date(now - 1000).toISOString() });
    assert.match(message(() => parse(incidentIn, body)), /startedAt/);
  });
});

describe("zone validation", () => {
  it("needs a name and 3 to 50 points inside the frame", () => {
    assert.ok(parse(zoneIn, { name: " Bay ", points: [[0, 0], [1, 0], [1, 1]] }));
    assert.equal(parse(zoneIn, { name: " Bay ", points: [[0, 0], [1, 0], [1, 1]] }).name, "Bay");
    message(() => parse(zoneIn, { name: "", points: [[0, 0], [1, 0], [1, 1]] }));
    message(() => parse(zoneIn, { name: "Bay", points: [[0, 0], [1, 0]] }));
    message(() => parse(zoneIn, { name: "Bay", points: [[0, 0], [1, 0], [1, 1.2]] }));
    message(() => parse(zoneIn, { name: "x".repeat(61), points: [[0, 0], [1, 0], [1, 1]] }));
  });
});

describe("list query", () => {
  it("defaults and bounds the page size", () => {
    assert.deepEqual(parse(listQuery, {}), { status: "all", limit: 50 });
    assert.equal(parse(listQuery, { limit: "200" }).limit, 200);
    message(() => parse(listQuery, { limit: "201" }));
    message(() => parse(listQuery, { status: "deleted" }));
  });
});

describe("upload backoff", () => {
  it("doubles per attempt with ±50% jitter", () => {
    assert.equal(backoffMs(1, 1000, () => 0.5), 1000);
    assert.equal(backoffMs(2, 1000, () => 0.5), 2000);
    assert.equal(backoffMs(4, 1000, () => 0.5), 8000);
    assert.equal(backoffMs(3, 1000, () => 0), 2000);
    assert.equal(backoffMs(3, 1000, () => 0.999), 5996);
  });
});
