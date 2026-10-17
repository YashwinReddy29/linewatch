import { closeAll, incidentBody, req, resetDatabase, sessionHeaders, WORKER_AUTH } from "../helpers";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { POST, GET } from "@/app/api/incidents/route";
import { query } from "@/lib/db";
import { readSnapshot } from "@/lib/storage";

const ingest = (body: unknown, headers: Record<string, string> = WORKER_AUTH) =>
  POST(req("/api/incidents", { method: "POST", headers, json: body }), undefined);

describe("POST /api/incidents", () => {
  before(resetDatabase);
  after(closeAll);

  it("stores a new incident and its snapshots: 201", async () => {
    const body = incidentBody();
    const res = await ingest(body);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.incident.id, body.id);
    assert.equal(json.duplicate, false);
    assert.equal(json.incident.hasRaw, true);
    assert.ok(await readSnapshot(body.id, "raw"));
    assert.ok(await readSnapshot(body.id, "annotated"));
    assert.ok(res.headers.get("x-request-id"));
  });

  it("treats a retried delivery as a duplicate: 200, still one row", async () => {
    const body = incidentBody();
    assert.equal((await ingest(body)).status, 201);
    const again = await ingest(body);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    const { rows } = await query<{ n: string }>("SELECT count(*) AS n FROM incidents WHERE id = $1", [body.id]);
    assert.equal(rows[0].n, "1");
  });

  it("stores exactly one row when 25 copies arrive at once", async () => {
    const body = incidentBody();
    const statuses = (await Promise.all(Array.from({ length: 25 }, () => ingest(body)))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 200).length, 24);
    const { rows } = await query<{ n: string }>("SELECT count(*) AS n FROM incidents WHERE id = $1", [body.id]);
    assert.equal(rows[0].n, "1");
  });

  it("propagates the worker's request ID", async () => {
    const res = await ingest(incidentBody(), { ...WORKER_AUTH, "x-request-id": "inc-abc.1" });
    assert.equal(res.headers.get("x-request-id"), "inc-abc.1");
  });

  it("refuses a missing or wrong worker token: 401", async () => {
    assert.equal((await ingest(incidentBody(), {})).status, 401);
    const res = await ingest(incidentBody(), { authorization: "Bearer wrong-token-0123456789" });
    assert.equal(res.status, 401);
    const err = (await res.json()).error;
    assert.equal(err.code, "bad_worker_token");
    assert.ok(err.requestId);
  });

  it("does not accept a session cookie in place of the worker token", async () => {
    assert.equal((await ingest(incidentBody(), await sessionHeaders())).status, 401);
  });

  it("rejects invalid fields with 400 and the field name", async () => {
    const res = await ingest(incidentBody({ confidence: 3 }));
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.equal(err.code, "validation_failed");
    assert.match(err.message, /confidence/);
  });

  it("rejects a snapshot that isn't a JPEG", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
    assert.equal((await ingest(incidentBody({ rawJpegBase64: png }))).status, 400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(
      req("/api/incidents", { method: "POST", headers: { ...WORKER_AUTH, "content-type": "application/json" }, body: "{" }),
      undefined,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  });

  it("stops reading an oversized body: 413", async () => {
    process.env.MAX_INGEST_BYTES = "1024";
    try {
      const res = await ingest(incidentBody({ rawJpegBase64: "A".repeat(4000) }));
      assert.equal(res.status, 413);
    } finally {
      delete process.env.MAX_INGEST_BYTES;
    }
  });
});

describe("GET /api/incidents", () => {
  before(resetDatabase);
  after(closeAll);

  const list = async (qs: string) =>
    GET(req(`/api/incidents${qs}`, { headers: await sessionHeaders() }), undefined);

  it("needs a session: 401", async () => {
    assert.equal((await GET(req("/api/incidents"), undefined)).status, 401);
  });

  it("pages newest first with a stable cursor and filters", async () => {
    const base = Date.parse("2026-10-01T12:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const t = new Date(base + i * 1000).toISOString();
      const body = incidentBody({ startedAt: t, triggeredAt: t, zoneId: i % 2 ? "odd" : "even" });
      ids.push(body.id);
      assert.equal((await ingest(body)).status, 201);
    }
    const newestFirst = ids.slice().reverse();

    const p1 = await (await list("?limit=3")).json();
    assert.deepEqual(p1.incidents.map((i: { id: string }) => i.id), newestFirst.slice(0, 3));
    const p2 = await (await list(`?limit=3&cursor=${p1.nextCursor}`)).json();
    assert.deepEqual(p2.incidents.map((i: { id: string }) => i.id), newestFirst.slice(3, 6));
    const p3 = await (await list(`?limit=3&cursor=${p2.nextCursor}`)).json();
    assert.deepEqual(p3.incidents.map((i: { id: string }) => i.id), newestFirst.slice(6));
    assert.equal(p3.nextCursor, null);

    const odd = await (await list("?zoneId=odd&limit=50")).json();
    assert.equal(odd.incidents.length, 3);
    const window = await (await list(`?from=${new Date(base + 2000).toISOString()}&to=${new Date(base + 4000).toISOString()}`)).json();
    assert.equal(window.incidents.length, 2);
  });

  it("rejects a forged cursor: 400", async () => {
    assert.equal((await list("?cursor=bm9wZQ")).status, 400);
  });
});
