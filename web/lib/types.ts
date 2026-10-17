export type IncidentStatus = "open" | "confirmed" | "false_alarm";
export type RoboflowStatus = "uploading" | "uploaded" | "failed" | "skipped" | null;

export interface Incident {
  id: string;
  trackerId: number;
  zoneId: string | null;
  zoneName: string | null;
  rule: string;
  startedAt: string;
  triggeredAt: string;
  durationS: number;
  violatingFrames: number;
  windowFrames: number;
  confidence: number;
  bbox: [number, number, number, number];
  hasSnapshot: boolean;
  hasRaw: boolean;
  status: IncidentStatus;
  reviewedAt: string | null;
  roboflowStatus: RoboflowStatus;
  roboflowImageId: string | null;
  roboflowError: string | null;
}

export interface Zone {
  id: string;
  name: string;
  points: [number, number][];
  active: boolean;
  createdAt: string;
}

export interface WorkerHealth {
  state: "starting" | "connecting" | "loading_model" | "running" | "error" | "offline";
  message: string;
  fps?: number;
  infer_ms?: number;
  zone?: string | null;
  incidents?: number;
  zone_error?: string | null;
}

export interface Counts {
  open: number;
  confirmed: number;
  false_alarm: number;
  all: number;
}

export interface StatusResponse {
  worker: WorkerHealth;
  zone: Zone | null;
  counts: Counts;
  roboflowConfigured: boolean;
  roboflowProjectUrl: string | null;
  streamUrl: string;
  siteName: string;
}

export type BusEvent =
  | { type: "incident.created"; incident: Incident }
  | { type: "incident.updated"; incident: Incident }
  | { type: "zone.updated"; zone: Zone | null };
