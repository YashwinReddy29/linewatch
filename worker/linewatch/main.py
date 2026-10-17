"""Worker entry point.

Run from the repo root:
    PYTHONPATH=worker python -m linewatch.main
"""

from __future__ import annotations

import csv
import json
import logging
import signal
import sys
import time
import warnings
from datetime import datetime
from pathlib import Path

import requests
import supervision as sv

from . import metrics
from .config import Config
from .detector import Detector
from .geometry import denormalize
from .pipeline import draw, judge, to_observations
from .rules import ViolationTracker
from .sink import IncidentSink
from .stream import FrameHub, start_stream_server
from .video import VideoSource
from .zones import ZoneProvider

# sv.ByteTrack is deprecated in supervision 0.29 (moved to the `trackers` package)
# but inference-cli 1.8.0 still requires supervision<0.30, so we pin and silence it.
warnings.filterwarnings("ignore", message=".*ByteTrack.*", category=FutureWarning)

log = logging.getLogger("linewatch")


class JsonFormatter(logging.Formatter):
    """One JSON object per line, matching the web app's log shape."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created).astimezone().isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": "worker",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def setup_logging(fmt: str) -> None:
    handler = logging.StreamHandler()
    if fmt == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)


def wait_for_inference_server(config: Config, hub: FrameHub) -> None:
    url = f"{config.inference_url}/info"
    while True:
        try:
            requests.get(url, timeout=3).raise_for_status()
            log.info("Inference server reachable at %s", config.inference_url)
            return
        except requests.RequestException:
            hub.set_status(
                "error",
                f"Can't reach the Inference server at {config.inference_url}. "
                "Start it with `inference server start` or `docker compose up`.",
            )
            log.warning("Waiting for Inference server at %s ...", config.inference_url)
            time.sleep(3)


def open_source(config: Config, hub: FrameHub) -> VideoSource:
    while True:
        try:
            return VideoSource(
                config.video_source,
                loop=config.loop_video,
                max_width=config.max_width,
                stride=config.frame_stride,
            )
        except RuntimeError as exc:
            hub.set_status("error", f"{exc}. Check VIDEO_SOURCE in .env.")
            log.error("%s; retrying in 5s", exc)
            time.sleep(5)


class LatencyLog:
    FIELDS = ["frame", "ts", "person_ms", "ppe_ms", "infer_ms", "loop_ms", "people", "vests", "in_zone"]

    def __init__(self, out_dir: Path) -> None:
        folder = out_dir / "latency"
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / f"run_{datetime.now():%Y%m%d_%H%M%S}.csv"
        self._file = self.path.open("w", newline="")
        self._writer = csv.writer(self._file)
        self._writer.writerow(self.FIELDS)

    def write(self, *row) -> None:
        self._writer.writerow(row)
        self._file.flush()

    def close(self) -> None:
        self._file.close()


def run() -> int:
    config = Config()
    setup_logging(config.log_format)
    problems = config.validate()
    if problems:
        for p in problems:
            log.error(p)
        return 1

    hub = FrameHub()
    try:
        start_stream_server(hub, config.stream_port)
    except OSError:
        log.error(
            "Port %s is already in use (another app, or a worker that is still running). "
            "Set STREAM_PORT to a free port in .env, e.g. STREAM_PORT=8090. "
            "To see what holds it: ss -ltnp | grep :%s",
            config.stream_port,
            config.stream_port,
        )
        return 1
    log.info("Live view: http://localhost:%s/stream.mjpg", config.stream_port)

    wait_for_inference_server(config, hub)
    source = open_source(config, hub)
    detector = Detector(config)

    first = source.read()
    if first is None:
        hub.set_status("error", "Video source returned no frames.")
        log.error("Video source returned no frames")
        return 1

    hub.set_status("loading_model", "Downloading models (first run only). This can take a minute.")
    if detector.single_model:
        log.info("Warming up model %s (people + vests in one call) ...", config.person_model_id)
    else:
        log.info("Warming up models %s and %s ...", config.person_model_id, config.ppe_model_id)
    try:
        warm_s = detector.warm_up(first)
    except Exception as exc:  # surface any SDK error clearly
        hub.set_status("error", f"Model load failed: {exc}. Check the model IDs and API key.")
        log.error("Model warm-up failed: %s", exc)
        return 1
    log.info("Models ready in %.1fs (includes download on first run)", warm_s)

    tracker = sv.ByteTrack(
        track_activation_threshold=config.track_activation,
        lost_track_buffer=config.track_lost_buffer,
        minimum_matching_threshold=config.track_match,
        frame_rate=config.track_frame_rate,
    )
    rules = ViolationTracker(
        window=config.window_frames,
        min_violating=config.min_violating_frames,
        stale_seconds=config.stale_track_seconds,
        cooldown_seconds=config.incident_cooldown_seconds,
        dedupe_radius=config.dedupe_radius,
        dedupe_seconds=config.dedupe_seconds,
    )
    zones = ZoneProvider(config.web_url, config.zone_file, config.zone_poll_seconds, config.worker_token)
    sink = IncidentSink(config.web_url, config.out_dir, config.worker_token)
    latency = LatencyLog(config.out_dir)
    log.info("Writing per-frame latency to %s", latency.path)

    stopping = False

    def _stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    frame_no = 0
    merged_seen = 0
    fps_ema = 0.0
    incidents_total = 0
    try:
        while not stopping:
            loop_start = time.perf_counter()
            frame = source.read()
            if frame is None:
                hub.set_status("error", "Video source ended or disconnected.")
                log.warning("Video source ended")
                break

            h, w = frame.shape[:2]
            zone = zones.current
            zone_px = denormalize(zone.points, w, h) if zone else None

            dets = detector.detect(frame)
            people = tracker.update_with_detections(dets.people)
            statuses = judge(people, dets.vests, zone_px, config.vest_min_coverage)
            now = time.time()
            new_incidents = rules.update(to_observations(statuses), now)
            active = {s.tracker_id for s in statuses if rules.is_active(s.tracker_id)}

            loop_ms = (time.perf_counter() - loop_start) * 1000
            metrics.FRAMES.inc()
            metrics.LOOP_SECONDS.observe(loop_ms / 1000)
            metrics.INFER_SECONDS.labels(model=config.person_model_id).observe(dets.person_ms / 1000)
            if not detector.single_model:
                metrics.INFER_SECONDS.labels(model=config.ppe_model_id).observe(dets.ppe_ms / 1000)
            fps_ema = (1000 / loop_ms) if fps_ema == 0 else 0.9 * fps_ema + 0.1 * (1000 / loop_ms)
            in_zone = sum(1 for s in statuses if s.in_zone)
            metrics.PEOPLE_IN_ZONE.set(in_zone)
            hud = (
                f"{fps_ema:4.1f} FPS  |  inference {dets.infer_ms:5.0f} ms  |  "
                f"in zone {in_zone}  |  incidents {incidents_total + len(new_incidents)}"
            )
            annotated = draw(frame, statuses, dets.vests, zone_px, zone.name if zone else None, active, hud)
            hub.publish(frame, annotated)

            for inc in new_incidents:
                incidents_total += 1
                metrics.INCIDENTS.inc()
                incident_id = sink.submit(inc, zone, annotated, frame)
                log.info(
                    "Incident %s: track %s without vest in %s",
                    incident_id,
                    inc.tracker_id,
                    zone.name if zone else "?",
                )
            if rules.suppressed > merged_seen:
                metrics.MERGED.inc(rules.suppressed - merged_seen)
                merged_seen = rules.suppressed

            hub.set_status(
                "running",
                "Monitoring" if zone else "No zone set",
                fps=round(fps_ema, 1),
                infer_ms=round(dets.infer_ms, 1),
                zone=zone.name if zone else None,
                incidents=incidents_total,
                zone_error=zones.last_error,
            )
            latency.write(
                frame_no,
                f"{now:.3f}",
                f"{dets.person_ms:.2f}",
                f"{dets.ppe_ms:.2f}",
                f"{dets.infer_ms:.2f}",
                f"{loop_ms:.2f}",
                len(dets.people),
                len(dets.vests),
                in_zone,
            )
            frame_no += 1
    finally:
        log.info(
            "Stopping after %s frames, %s incidents (%s merged as re-identified people)",
            frame_no,
            incidents_total,
            rules.suppressed,
        )
        hub.set_status("stopping", "Worker is shutting down")
        sink.close(config.drain_seconds)
        latency.close()
        detector.close()
        source.release()
        zones.stop()
    return 0


if __name__ == "__main__":
    sys.exit(run())
