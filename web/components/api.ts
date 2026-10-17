"use client";

/** fetch() for the console's own API: a 401 means the session expired, so go to the login page. */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    // A full page load on purpose: it drops every piece of client state from the old session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  return res;
}

/** The API's error body is { error: { code, message, requestId } }. */
export function errorMessage(body: unknown, status: number): string {
  const err = (body as { error?: { message?: string } } | null)?.error;
  return err?.message ?? `HTTP ${status}`;
}
