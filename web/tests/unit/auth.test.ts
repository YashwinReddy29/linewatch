import "../helpers";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearLoginFailures,
  createSessionToken,
  loginBlockedFor,
  recordLoginFailure,
  requireSession,
  requireWorker,
  secretsEqual,
  verifySessionToken,
} from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { req, sessionHeaders, WORKER_AUTH } from "../helpers";

describe("session tokens", () => {
  it("accepts a fresh token", async () => {
    assert.equal(await verifySessionToken(await createSessionToken()), true);
  });

  it("rejects a tampered payload or signature", async () => {
    const token = await createSessionToken();
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, exp: 9_999_999_999 })).toString("base64url");
    assert.equal(await verifySessionToken(`${forged}.${sig}`), false);
    assert.equal(await verifySessionToken(`${payload}.${sig.slice(0, -2)}AA`), false);
    assert.equal(await verifySessionToken(`${payload}.${sig}.extra`), false);
    assert.equal(await verifySessionToken("garbage"), false);
    assert.equal(await verifySessionToken(null), false);
  });

  it("rejects an expired token", async () => {
    const issued = Date.now() - 13 * 3600 * 1000; // default session is 12 h
    assert.equal(await verifySessionToken(await createSessionToken(issued)), false);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await createSessionToken();
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "x".repeat(48);
    try {
      assert.equal(await verifySessionToken(token), false);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

describe("secretsEqual", () => {
  it("compares by value, never matches empty", async () => {
    assert.equal(await secretsEqual("abc", "abc"), true);
    assert.equal(await secretsEqual("abc", "abd"), false);
    assert.equal(await secretsEqual("abc", "abcd"), false);
    assert.equal(await secretsEqual("", ""), false);
  });
});

async function status(p: Promise<void>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err.status;
  }
}

describe("requireWorker", () => {
  it("needs the exact bearer token", async () => {
    assert.equal(await status(requireWorker(req("/x", { headers: WORKER_AUTH }))), 200);
    assert.equal(await status(requireWorker(req("/x", { headers: { authorization: "Bearer nope" } }))), 401);
    assert.equal(await status(requireWorker(req("/x"))), 401);
  });

  it("refuses everything when no token is configured", async () => {
    const saved = process.env.WORKER_TOKEN;
    process.env.WORKER_TOKEN = "";
    try {
      assert.equal(await status(requireWorker(req("/x", { headers: { authorization: "Bearer " } }))), 503);
    } finally {
      process.env.WORKER_TOKEN = saved;
    }
  });
});

describe("requireSession", () => {
  it("needs a valid cookie", async () => {
    assert.equal(await status(requireSession(req("/x", { headers: await sessionHeaders() }))), 200);
    assert.equal(await status(requireSession(req("/x"))), 401);
  });

  it("refuses cross-site writes even with a valid cookie", async () => {
    const headers = { ...(await sessionHeaders()), origin: "https://evil.example" };
    assert.equal(await status(requireSession(req("/x", { method: "POST", headers }))), 403);
    const same = { ...(await sessionHeaders()), origin: "http://localhost:3000" };
    assert.equal(await status(requireSession(req("/x", { method: "POST", headers: same }))), 200);
  });

  it("is skipped only with AUTH_DISABLED=true", async () => {
    process.env.AUTH_DISABLED = "true";
    try {
      assert.equal(await status(requireSession(req("/x"))), 200);
    } finally {
      delete process.env.AUTH_DISABLED;
    }
  });
});

describe("login rate limit", () => {
  it("blocks after 5 failures in the window and resets after it", () => {
    const now = 1_000_000;
    clearLoginFailures("t");
    for (let i = 0; i < 4; i++) recordLoginFailure("t", now);
    assert.equal(loginBlockedFor("t", now), 0);
    recordLoginFailure("t", now);
    assert.ok(loginBlockedFor("t", now) > 0);
    assert.equal(loginBlockedFor("t", now + 15 * 60 * 1000 + 1), 0);
  });
});
