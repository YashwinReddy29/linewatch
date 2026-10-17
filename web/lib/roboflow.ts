/**
 * Sends a frame back into a Roboflow project for relabeling.
 * Mirrors the official roboflow-python SDK (adapters/rfapi.py upload_image):
 *   POST https://api.roboflow.com/dataset/{project}/upload?api_key=…&batch=…&tag=…
 *   multipart body: name, split, file
 */

import { env } from "./env";

export function roboflowConfig() {
  const apiKey = env.roboflowApiKey();
  const project = env.roboflowProject();
  const workspace = env.roboflowWorkspace();
  return { apiKey, project, workspace, configured: Boolean(apiKey && project) };
}

export function roboflowProjectUrl(): string | null {
  const { workspace, project } = roboflowConfig();
  return workspace && project ? `https://app.roboflow.com/${workspace}/${project}/annotate` : null;
}

export interface UploadResult {
  ok: boolean;
  imageId?: string;
  duplicate?: boolean;
  error?: string;
  /** False when retrying can't help (bad key, unknown project, rejected image). */
  retryable?: boolean;
}

/** Network errors, timeouts, 408, 429 and 5xx are worth retrying; other 4xx are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function uploadFalseAlarm(imageName: string, jpeg: Buffer): Promise<UploadResult> {
  const { apiKey, project, configured } = roboflowConfig();
  if (!configured) return { ok: false, error: "ROBOFLOW_PROJECT is not set", retryable: false };

  const params = new URLSearchParams({ api_key: apiKey, batch: "linewatch-false-alarms" });
  params.append("tag", "false-alarm");
  params.append("tag", "linewatch");
  const url = `https://api.roboflow.com/dataset/${encodeURIComponent(project)}/upload?${params}`;

  const form = new FormData();
  form.append("name", imageName);
  form.append("split", "train");
  form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), imageName);

  try {
    const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; duplicate?: boolean; id?: string; message?: string; error?: unknown }
      | null;
    if (!res.ok || !body || !(body.success || body.duplicate)) {
      const message =
        (body && (body.message || (typeof body.error === "string" ? body.error : JSON.stringify(body.error)))) ||
        `HTTP ${res.status}`;
      return { ok: false, error: message, retryable: !res.ok ? isRetryableStatus(res.status) : true };
    }
    return { ok: true, imageId: body.id, duplicate: Boolean(body.duplicate) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}
