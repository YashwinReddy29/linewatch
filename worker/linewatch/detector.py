"""Calls the Roboflow Inference server for people and vests.

Two setups are supported:
- one model that detects both (PERSON_MODEL_ID == PPE_MODEL_ID): one call per frame
- a person model plus a PPE model: two calls per frame, run in parallel
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np
import supervision as sv
from inference_sdk import InferenceConfiguration, InferenceHTTPClient

from .config import Config

# Ask the server for low-confidence boxes; we apply our own thresholds per class.
SERVER_CONFIDENCE = 0.2


@dataclass
class FrameDetections:
    people: sv.Detections
    vests: sv.Detections
    person_ms: float
    ppe_ms: float
    infer_ms: float  # wall time for all calls (parallel when two models)


def keep_classes(detections: sv.Detections, class_names: list[str], min_conf: float) -> sv.Detections:
    """Keep detections whose class (case-insensitive) is in class_names and above min_conf."""
    if len(detections) == 0:
        return detections
    names = np.array([str(n).lower() for n in detections.data.get("class_name", [])])
    if names.size != len(detections):
        return detections[np.zeros(len(detections), dtype=bool)]
    wanted = [c.lower() for c in class_names]
    mask = np.isin(names, wanted) & (detections.confidence >= min_conf)
    return detections[mask]


def make_client(config: Config) -> InferenceHTTPClient:
    client = InferenceHTTPClient(api_url=config.inference_url, api_key=config.api_key)
    client.configure(
        InferenceConfiguration(confidence_threshold=SERVER_CONFIDENCE, api_key_transport="header")
    )
    return client


class Detector:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.single_model = config.person_model_id == config.ppe_model_id
        # One client per model so parallel calls never share a session.
        self._person_client = make_client(config)
        self._ppe_client = self._person_client if self.single_model else make_client(config)
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="infer")

    def _infer(self, client: InferenceHTTPClient, frame: np.ndarray, model_id: str):
        start = time.perf_counter()
        result = client.infer(frame, model_id=model_id)
        elapsed_ms = (time.perf_counter() - start) * 1000
        return sv.Detections.from_inference(result), elapsed_ms

    def detect(self, frame: np.ndarray) -> FrameDetections:
        cfg = self.config
        start = time.perf_counter()
        if self.single_model:
            raw, ms = self._infer(self._person_client, frame, cfg.person_model_id)
            raw_people, raw_ppe, person_ms, ppe_ms = raw, raw, ms, ms
        else:
            person_future = self._pool.submit(self._infer, self._person_client, frame, cfg.person_model_id)
            ppe_future = self._pool.submit(self._infer, self._ppe_client, frame, cfg.ppe_model_id)
            raw_people, person_ms = person_future.result()
            raw_ppe, ppe_ms = ppe_future.result()
        infer_ms = (time.perf_counter() - start) * 1000

        people = keep_classes(raw_people, cfg.person_classes, cfg.person_confidence)
        vests = keep_classes(raw_ppe, cfg.vest_classes, cfg.vest_confidence)
        return FrameDetections(people, vests, person_ms, ppe_ms, infer_ms)

    def warm_up(self, frame: np.ndarray) -> float:
        """First call per model makes the server download weights. Returns seconds taken."""
        start = time.perf_counter()
        self.detect(frame)
        return time.perf_counter() - start

    def close(self) -> None:
        self._pool.shutdown(wait=False)
