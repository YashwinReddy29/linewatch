import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "./env";

const dataDir = () => env.dataDir() || path.join(process.cwd(), ".data");

export type SnapshotKind = "annotated" | "raw";

function snapshotPath(id: string, kind: SnapshotKind): string {
  return path.join(dataDir(), "snapshots", `${id}_${kind}.jpg`);
}

/**
 * Write-then-rename, so a crash never leaves a half-written JPEG under the final name.
 * Keyed by incident id: a retried ingest overwrites the same file with the same bytes.
 */
export async function saveSnapshot(id: string, kind: SnapshotKind, base64: string): Promise<void> {
  const file = snapshotPath(id, kind);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, Buffer.from(base64, "base64"));
  await rename(tmp, file);
}

export async function readSnapshot(id: string, kind: SnapshotKind): Promise<Buffer | null> {
  try {
    return await readFile(snapshotPath(id, kind));
  } catch {
    return null;
  }
}
