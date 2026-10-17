import { publish } from "./bus";
import { getIncident, setRoboflowState } from "./db";
import { roboflowConfig, uploadFalseAlarm } from "./roboflow";
import { readSnapshot } from "./storage";

/** Uploads an incident's clean frame to Roboflow in the background and broadcasts each state. */
export async function sendToRoboflow(id: string): Promise<void> {
  if (!roboflowConfig().configured) {
    const skipped = await setRoboflowState(id, "skipped", null, "Set ROBOFLOW_PROJECT to send false alarms");
    if (skipped) publish({ type: "incident.updated", incident: skipped });
    return;
  }
  const incident = await getIncident(id);
  if (!incident) return;
  // Prefer the clean frame: boxes drawn on an image would poison a training set.
  const jpeg = (await readSnapshot(id, "raw")) ?? null;
  if (!jpeg) {
    const failed = await setRoboflowState(id, "failed", null, "No clean frame was saved for this incident");
    if (failed) publish({ type: "incident.updated", incident: failed });
    return;
  }

  const uploading = await setRoboflowState(id, "uploading");
  if (uploading) publish({ type: "incident.updated", incident: uploading });

  const name = `linewatch_${incident.triggeredAt.replace(/[:.]/g, "-")}_track${incident.trackerId}.jpg`;
  const result = await uploadFalseAlarm(name, jpeg);
  const done = result.ok
    ? await setRoboflowState(id, "uploaded", result.imageId ?? null, null)
    : await setRoboflowState(id, "failed", null, result.error ?? "Upload failed");
  if (done) publish({ type: "incident.updated", incident: done });
}
