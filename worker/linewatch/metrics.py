"""Prometheus metrics for the worker, served at GET /metrics on the stream port."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

REGISTRY = CollectorRegistry(auto_describe=True)

FRAMES = Counter("linewatch_frames_processed_total", "Frames run through the models", registry=REGISTRY)
LOOP_SECONDS = Histogram(
    "linewatch_frame_loop_seconds",
    "Full per-frame loop time: read, infer, track, judge, draw",
    buckets=(0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0),
    registry=REGISTRY,
)
INFER_SECONDS = Histogram(
    "linewatch_inference_seconds",
    "Inference server round trip per model",
    ["model"],
    buckets=(0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0),
    registry=REGISTRY,
)
PEOPLE_IN_ZONE = Gauge(
    "linewatch_people_in_zone", "People whose feet are inside the zone, last frame", registry=REGISTRY
)
INCIDENTS = Counter("linewatch_incidents_fired_total", "Incidents raised by the rule", registry=REGISTRY)
MERGED = Counter(
    "linewatch_incidents_merged_total",
    "Would-be incidents merged into a live one (re-identified people)",
    registry=REGISTRY,
)
DELIVERIES = Counter(
    "linewatch_deliveries_total",
    "Outbox delivery attempts to the web app, by outcome (delivered, retry, dead)",
    ["outcome"],
    registry=REGISTRY,
)
OUTBOX_PENDING = Gauge(
    "linewatch_outbox_pending", "Incidents on disk waiting for delivery", registry=REGISTRY
)
