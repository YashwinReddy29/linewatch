"""Where incidents go.

With WEB_URL set: POST to the web app (in a background thread, with retries,
so a slow network never stalls video processing). Without it: write the
snapshot and a JSON line into out/incidents/ so the worker works alone.
"""

from __future__ import annotations

import base64
import json
import logging
import queue
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
import requests

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
    incident: Incident, zone: Zone | None, snapshot: np.ndarray, raw: np.ndarray | None = None
) -> dict:
    """snapshot = frame with detections drawn (for people); raw = clean frame (for retraining)."""
    h, w = snapshot.shape[:2]
    x1, y1, x2, y2 = incident.xyxy
    return {
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
        "bbox": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
        "snapshotJpegBase64": _b64jpg(snapshot),
        "rawJpegBase64": _b64jpg(raw, quality=92),
    }


class IncidentSink:
    def __init__(self, web_url: str, out_dir: Path, token: str = "") -> None:
        self.web_url = web_url
        self.token = token
        self.out_dir = out_dir / "incidents"
        self.sent = 0
        self.failed = 0
        self._queue: queue.Queue[dict] = queue.Queue(maxsize=100)
        if not web_url:
            self.out_dir.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._run, daemon=True, name="sink").start()

    def submit(
        self, incident: Incident, zone: Zone | None, snapshot: np.ndarray, raw: np.ndarray | None = None
    ) -> None:
        try:
            self._queue.put_nowait(build_payload(incident, zone, snapshot, raw))
        except queue.Full:
            self.failed += 1
            log.error("Incident queue full; dropping incident for track %s", incident.tracker_id)

    def _run(self) -> None:
        while True:
            payload = self._queue.get()
            if self.web_url:
                self._post(payload)
            else:
                self._write_local(payload)

    def _post(self, payload: dict) -> None:
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        for attempt in range(4):
            try:
                resp = requests.post(
                    f"{self.web_url}/api/incidents", json=payload, headers=headers, timeout=5
                )
                resp.raise_for_status()
                self.sent += 1
                return
            except requests.RequestException as exc:
                wait = 2**attempt
                log.warning("POST incident failed (%s); retrying in %ss", exc, wait)
                time.sleep(wait)
        self.failed += 1
        log.error("Gave up sending incident for track %s", payload["trackerId"])

    def _write_local(self, payload: dict) -> None:
        stamp = payload["triggeredAt"].replace(":", "-")
        name = f"{stamp}_track{payload['trackerId']}"
        snapshot = payload.pop("snapshotJpegBase64")
        raw = payload.pop("rawJpegBase64", None)
        if snapshot:
            (self.out_dir / f"{name}.jpg").write_bytes(base64.b64decode(snapshot))
            payload["snapshot"] = f"{name}.jpg"
        if raw:
            (self.out_dir / f"{name}_raw.jpg").write_bytes(base64.b64decode(raw))
            payload["raw"] = f"{name}_raw.jpg"
        with (self.out_dir / "incidents.jsonl").open("a") as f:
            f.write(json.dumps(payload) + "\n")
        self.sent += 1
