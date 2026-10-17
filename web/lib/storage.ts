import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = () => process.env.DATA_DIR ?? path.join(process.cwd(), ".data");

function snapshotPath(id: string, kind: "annotated" | "raw"): string {
  return path.join(dataDir(), "snapshots", `${id}_${kind}.jpg`);
}

export async function saveSnapshot(id: string, kind: "annotated" | "raw", base64: string): Promise<void> {
  const file = snapshotPath(id, kind);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(base64, "base64"));
}

export async function readSnapshot(id: string, kind: "annotated" | "raw"): Promise<Buffer | null> {
  try {
    return await readFile(snapshotPath(id, kind));
  } catch {
    return null;
  }
}
