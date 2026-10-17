"""Where incidents go.

With WEB_URL set: into the durable outbox (outbox.py), which delivers them to the web app.
Without it: the snapshot and a JSON line go to out/incidents/, so the worker runs alone.
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
import requests

from . import metrics
from .outbox import Outbox, Outcome, Result
from .rules import Incident
from .zones import Zone

log = logging.getLogger("linewatch.sink")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).isoformat()


def _b64jpg(image: np.ndarray | None, quality: int = 85) -> str | None:
    if image is None:
        return None
    ok, jpg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(jpg.tobytes()).decode() if ok else None


def build_payload(
    incident: Incident,
    zone: Zone | None,
    snapshot: np.ndarray,
    raw: np.ndarray | None = None,
    incident_id: str | None = None,
) -> dict:
    """snapshot = frame with detections drawn (for people); raw = clean frame (for retraining).
    `id` is generated here, once: every retry of this incident carries the same id."""
    h, w = snapshot.shape[:2]
    x1, y1, x2, y2 = incident.xyxy

    def unit(v: float) -> float:
        return round(min(1.0, max(0.0, v)), 4)

    return {
        "id": incident_id or str(uuid.uuid4()),
        "trackerId": incident.tracker_id,
        "zoneId": zone.id if zone else None,
        "zoneName": zone.name if zone else None,
        "rule": "no_vest_in_zone",
        "startedAt": _iso(incident.started_at),
        "triggeredAt": _iso(incident.triggered_at),
        "durationS": round(incident.duration_s, 2),
        "violatingFrames": incident.violating_frames,
        "windowFrames": incident.window_frames,
        "confidence": round(float(incident.confidence), 3),
        "bbox": [unit(x1 / w), unit(y1 / h), unit(x2 / w), unit(y2 / h)],
        "snapshotJpegBase64": _b64jpg(snapshot),
        "rawJpegBase64": _b64jpg(raw, quality=92),
    }


def classify(status: int) -> Outcome:
    """What an HTTP status from POST /api/incidents means for the outbox."""
    if status in (200, 201):
        return Outcome.DELIVERED  # 200 = the web app already had it (a retried delivery)
    if status in (408, 429) or status >= 500:
        return Outcome.RETRY
    return Outcome.DEAD


class HttpSender:
    """Sends one payload. Never raises: every failure becomes an Outcome."""

    def __init__(self, web_url: str, token: str, timeout: tuple[float, float] = (3.0, 15.0)) -> None:
        self.url = f"{web_url}/api/incidents"
        self.token = token
        self.timeout = timeout
        self.session = requests.Session()

    def __call__(self, payload: dict) -> Result:
        headers = {"X-Request-ID": payload["id"]}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            resp = self.session.post(self.url, json=payload, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:
            return Result(Outcome.RETRY, f"{type(exc).__name__}: {exc}")
        outcome = classify(resp.status_code)
        detail = f"HTTP {resp.status_code}: {resp.text[:500]}" if outcome is not Outcome.DELIVERED else ""
        return Result(outcome, detail)


class IncidentSink:
    def __init__(self, web_url: str, out_dir: Path, token: str = "") -> None:
        self.web_url = web_url
        self.local_dir = out_dir / "incidents"
        self.outbox: Outbox | None = None
        if web_url:
            self.outbox = Outbox(
                out_dir / "outbox",
                HttpSender(web_url, token),
                on_result=lambda o: metrics.DELIVERIES.labels(outcome=o.value).inc(),
            )
            metrics.OUTBOX_PENDING.set_function(self.outbox.pending_count)
            self.outbox.start()
        else:
            self.local_dir.mkdir(parents=True, exist_ok=True)

    def submit(
        self, incident: Incident, zone: Zone | None, snapshot: np.ndarray, raw: np.ndarray | None = None
    ) -> str:
        payload = build_payload(incident, zone, snapshot, raw)
        if self.outbox:
            self.outbox.put(payload)
        else:
            self._write_local(payload)
        return payload["id"]

    def close(self, drain_seconds: float) -> None:
        if self.outbox:
            left = self.outbox.drain(drain_seconds)
            if left:
                log.warning("%s incident(s) still in the outbox; they are delivered on the next start", left)

    def _write_local(self, payload: dict) -> None:
        name = payload["id"]
        snapshot = payload.pop("snapshotJpegBase64")
        raw = payload.pop("rawJpegBase64", None)
        if snapshot:
            (self.local_dir / f"{name}.jpg").write_bytes(base64.b64decode(snapshot))
            payload["snapshot"] = f"{name}.jpg"
        if raw:
            (self.local_dir / f"{name}_raw.jpg").write_bytes(base64.b64decode(raw))
            payload["raw"] = f"{name}_raw.jpg"
        with (self.local_dir / "incidents.jsonl").open("a") as f:
            f.write(json.dumps(payload) + "\n")
