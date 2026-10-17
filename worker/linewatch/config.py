"""All worker settings come from environment variables (or a .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _list(name: str, default: str) -> list[str]:
    raw = os.environ.get(name, default)
    return [item.strip().lower() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Config:
    # Roboflow / Inference server
    api_key: str = field(default_factory=lambda: os.environ.get("ROBOFLOW_API_KEY", ""))
    inference_url: str = field(
        default_factory=lambda: os.environ.get("INFERENCE_URL", "http://localhost:9001")
    )
    # Set both IDs to the same model to make a single call per frame.
    person_model_id: str = field(default_factory=lambda: os.environ.get("PERSON_MODEL_ID", "rfdetr-small"))
    ppe_model_id: str = field(
        default_factory=lambda: os.environ.get("PPE_MODEL_ID", "construction-site-safety/27")
    )
    person_classes: list[str] = field(default_factory=lambda: _list("PERSON_CLASSES", "person"))
    vest_classes: list[str] = field(default_factory=lambda: _list("VEST_CLASSES", "safety vest,vest"))
    person_confidence: float = field(default_factory=lambda: _float("PERSON_CONFIDENCE", 0.35))
    # Deliberately lower than the person threshold: proving a vest is present should be
    # easier than proving it is missing, which cuts false "no vest" alarms.
    vest_confidence: float = field(default_factory=lambda: _float("VEST_CONFIDENCE", 0.25))
    # Fraction of a vest box that must lie inside a person box to count as worn.
    vest_min_coverage: float = field(default_factory=lambda: _float("VEST_MIN_COVERAGE", 0.5))

    # Video
    video_source: str = field(
        default_factory=lambda: os.environ.get("VIDEO_SOURCE", "samples/street-crew.mp4")
    )
    loop_video: bool = field(default_factory=lambda: os.environ.get("LOOP_VIDEO", "true").lower() == "true")
    max_width: int = field(default_factory=lambda: _int("MAX_WIDTH", 1280))
    # 0 = play files in real time like a camera; N = process every Nth frame (repeatable eval passes)
    frame_stride: int = field(default_factory=lambda: _int("FRAME_STRIDE", 0))

    # Incident rule (majority filter over a sliding window, per tracked person)
    window_frames: int = field(default_factory=lambda: _int("WINDOW_FRAMES", 6))
    min_violating_frames: int = field(default_factory=lambda: _int("MIN_VIOLATING_FRAMES", 4))
    stale_track_seconds: float = field(default_factory=lambda: _float("STALE_TRACK_SECONDS", 10.0))
    incident_cooldown_seconds: float = field(
        default_factory=lambda: _float("INCIDENT_COOLDOWN_SECONDS", 60.0)
    )
    # A new track that fires within DEDUPE_RADIUS person-heights of a live incident (person seen in
    # the last DEDUPE_SECONDS) joins it instead of raising a new one. 0 turns it off.
    dedupe_radius: float = field(default_factory=lambda: _float("DEDUPE_RADIUS", 1.0))
    dedupe_seconds: float = field(default_factory=lambda: _float("DEDUPE_SECONDS", 15.0))

    # ByteTrack tuning. New tracks need confidence > activation + 0.1, so keep this low when
    # the detector is unsure about small, distant people.
    track_activation: float = field(default_factory=lambda: _float("TRACK_ACTIVATION_THRESHOLD", 0.2))
    track_lost_buffer: int = field(default_factory=lambda: _int("TRACK_LOST_BUFFER", 30))
    track_match: float = field(default_factory=lambda: _float("TRACK_MATCH_THRESHOLD", 0.8))
    # Roughly the FPS the worker actually achieves; ByteTrack scales its lost buffer by it.
    track_frame_rate: int = field(default_factory=lambda: _int("TRACK_FRAME_RATE", 5))

    # Zone: polled from the web app if WEB_URL is set, else read from ZONE_FILE
    web_url: str = field(default_factory=lambda: os.environ.get("WEB_URL", "").rstrip("/"))
    worker_token: str = field(default_factory=lambda: os.environ.get("WORKER_TOKEN", ""))
    zone_file: Path = field(default_factory=lambda: Path(os.environ.get("ZONE_FILE", "worker/zone.json")))
    zone_poll_seconds: float = field(default_factory=lambda: _float("ZONE_POLL_SECONDS", 3.0))

    # Outputs
    stream_port: int = field(default_factory=lambda: _int("STREAM_PORT", 8090))
    out_dir: Path = field(default_factory=lambda: Path(os.environ.get("OUT_DIR", "out")))

    def validate(self) -> list[str]:
        problems = []
        if not self.api_key:
            problems.append(
                "ROBOFLOW_API_KEY is missing. Get it from Roboflow > Settings > API Keys and put it in .env."
            )
        if self.min_violating_frames > self.window_frames:
            problems.append("MIN_VIOLATING_FRAMES cannot be larger than WINDOW_FRAMES.")
        if not 0 < self.vest_min_coverage <= 1:
            problems.append("VEST_MIN_COVERAGE must be between 0 and 1.")
        return problems
