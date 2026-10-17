"""Shared helpers for the benchmark scripts. Run them from the repo root with the venv active."""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import requests
from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))  # reuse the worker's outbox and sender


def frame_jpegs() -> tuple[str, str, int]:
    """Two JPEGs the size of a real 1280x720 incident snapshot: (annotated b64, raw b64, bytes)."""
    import base64

    import cv2
    import numpy as np

    rng = np.random.default_rng(7)
    # Smooth gradient + texture: compresses like a camera frame, not like flat colour or pure noise.
    y, x = np.mgrid[0:720, 0:1280]
    base = np.stack([(x / 5) % 255, (y / 3) % 255, ((x + y) / 7) % 255], axis=-1)
    img = np.clip(base + rng.normal(0, 12, base.shape), 0, 255).astype(np.uint8)
    ok1, a = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    ok2, r = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok1 and ok2
    return base64.b64encode(a.tobytes()).decode(), base64.b64encode(r.tobytes()).decode(), len(a) + len(r)


def incident(annotated: str, raw: str, n: int = 0) -> dict:
    now = datetime.now(UTC)
    return {
        "id": str(uuid.uuid4()),
        "trackerId": n,
        "zoneId": "bench",
        "zoneName": "Benchmark zone",
        "rule": "no_vest_in_zone",
        "startedAt": (now - timedelta(seconds=2)).isoformat(),
        "triggeredAt": now.isoformat(),
        "durationS": 2.0,
        "violatingFrames": 4,
        "windowFrames": 6,
        "confidence": 0.8,
        "bbox": [0.1, 0.2, 0.3, 0.6],
        "snapshotJpegBase64": annotated,
        "rawJpegBase64": raw,
    }


def worker_token() -> str:
    token = os.environ.get("WORKER_TOKEN", "")
    if len(token) < 16:
        sys.exit("Set WORKER_TOKEN (16+ characters) in .env")
    return token


def console_session(web: str) -> requests.Session:
    s = requests.Session()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if password:
        resp = s.post(f"{web}/api/auth/login", json={"password": password}, timeout=5)
        if resp.status_code != 200:
            sys.exit(f"Console sign-in failed: HTTP {resp.status_code} {resp.text[:200]}")
    return s


def stored_ids(s: requests.Session, web: str, wanted: set[str]) -> dict[str, int]:
    """How many times each wanted id appears across every page of GET /api/incidents."""
    seen: dict[str, int] = {}
    cursor = None
    while True:
        params = {"limit": 200, **({"cursor": cursor} if cursor else {})}
        body = s.get(f"{web}/api/incidents", params=params, timeout=30).json()
        for inc in body["incidents"]:
            if inc["id"] in wanted:
                seen[inc["id"]] = seen.get(inc["id"], 0) + 1
        cursor = body.get("nextCursor")
        if not cursor:
            return seen


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def summarize_ms(values: list[float]) -> dict:
    return {
        "mean": round(statistics.fmean(values), 1),
        "p50": round(percentile(values, 50), 1),
        "p95": round(percentile(values, 95), 1),
        "p99": round(percentile(values, 99), 1),
        "max": round(max(values), 1),
    }


def machine() -> dict:
    import platform

    cpu = ""
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    return {"cpu": cpu, "cores": os.cpu_count(), "python": platform.python_version(), "os": platform.platform()}


def save(name: str, result: dict) -> Path:
    out = ROOT / "bench" / "results"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{name}_{time.strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    return path
