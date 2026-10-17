/**
 * Signed session tokens: base64url(JSON {v, exp}) + "." + base64url(HMAC-SHA256).
 * Web Crypto only and no heavy imports, so proxy.ts can use it too.
 */
import { env } from "./env";

export const SESSION_COOKIE = "lw_session";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionToken(nowMs = Date.now()): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ v: 1, exp: Math.floor(nowMs / 1000) + env.sessionHours() * 3600 })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.sessionSecret()), encoder.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** Constant-time signature check (crypto.subtle.verify), then expiry. */
export async function verifySessionToken(token: string | undefined | null, nowMs = Date.now()): Promise<boolean> {
  const secret = env.sessionSecret();
  if (!token || secret.length < 32) return false;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return false;
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), new Uint8Array(sigBytes), encoder.encode(payload));
  if (!ok) return false;
  try {
    const { v, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: number; exp?: number };
    return v === 1 && typeof exp === "number" && exp * 1000 > nowMs;
  } catch {
    return false;
  }
}
