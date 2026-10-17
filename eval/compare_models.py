"""Compare candidate models on YOUR footage before picking one.

Samples frames from each video, runs every model on the same frames through
the local Inference server, and reports per-model:
  - how many person / vest / no-vest boxes it found (at a stated confidence)
  - round-trip latency p50 / p95
and saves an annotated contact sheet per model in out/compare/ so you can
look at what each one actually detected.

These are detection counts, not accuracy: a model that finds more boxes is
not necessarily right. Use the contact sheets to judge, and the labeled test
set (eval_detections.py) for real precision / recall.

Usage (from repo root):
    python eval/compare_models.py samples/site1.mp4 samples/vest-closeup1.mp4
    python eval/compare_models.py samples/site1.mp4 --models construction-site-safety/27 rfdetr-nano
"""

from __future__ import annotations

import argparse
import os
import re
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from dotenv import find_dotenv, load_dotenv
from inference_sdk import InferenceConfiguration, InferenceHTTPClient

load_dotenv(find_dotenv(usecwd=True))

DEFAULT_MODELS = [
    "personal-protective-equipment-combined-model/8",
    "construction-site-safety/27",
    "ppe-bacnb/1",
]
PERSON_WORDS = {"person"}
VEST_WORDS = {"safety vest", "vest", "hi-viz vest", "safety-vest", "reflective-vest"}
NO_VEST_WORDS = {"no-safety vest", "no-vest", "no vest", "no_vest", "without_vest"}


def sample_frames(video: Path, count: int, max_width: int = 1280) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    for i in range(count):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / count))
        ok, frame = cap.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        if w > max_width:
            frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
        frames.append(frame)
    cap.release()
    return frames


def contact_sheet(images: list[np.ndarray], cols: int = 3, cell_w: int = 480) -> np.ndarray:
    cells = []
    for img in images:
        h, w = img.shape[:2]
        cells.append(cv2.resize(img, (cell_w, int(h * cell_w / w))))
    cell_h = max(c.shape[0] for c in cells)
    cells = [cv2.copyMakeBorder(c, 0, cell_h - c.shape[0], 0, 0, cv2.BORDER_CONSTANT) for c in cells]
    while len(cells) % cols:
        cells.append(np.zeros_like(cells[0]))
    rows = [np.hstack(cells[i : i + cols]) for i in range(0, len(cells), cols)]
    return np.vstack(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    parser.add_argument("--frames", type=int, default=6, help="frames sampled per video")
    parser.add_argument("--conf", type=float, default=0.4, help="confidence used for counting")
    args = parser.parse_args()

    api_key = os.environ.get("ROBOFLOW_API_KEY", "")
    url = os.environ.get("INFERENCE_URL", "http://localhost:9001")
    if not api_key:
        raise SystemExit("ROBOFLOW_API_KEY missing in .env")

    frames: list[np.ndarray] = []
    for video in args.videos:
        got = sample_frames(video, args.frames)
        print(f"{video}: {len(got)} frames")
        frames += got
    if not frames:
        raise SystemExit("No frames read.")

    client = InferenceHTTPClient(api_url=url, api_key=api_key)
    client.configure(InferenceConfiguration(confidence_threshold=0.2, api_key_transport="header"))
    out_dir = Path("out/compare")
    out_dir.mkdir(parents=True, exist_ok=True)
    box = sv.BoxAnnotator(thickness=2)
    label = sv.LabelAnnotator(text_scale=0.4, text_padding=3)

    rows = []
    for model in args.models:
        print(f"\n== {model}")
        try:
            t0 = time.perf_counter()
            client.infer(frames[0], model_id=model)  # downloads weights on first use
            print(f"   first call (incl. download): {time.perf_counter() - t0:.1f}s")
        except Exception as exc:  # show the real SDK error, keep going
            print(f"   FAILED to load: {exc}")
            continue

        timings, classes, sheets = [], Counter(), []
        counts = Counter()
        for frame in frames:
            t = time.perf_counter()
            result = client.infer(frame, model_id=model)
            timings.append((time.perf_counter() - t) * 1000)
            det = sv.Detections.from_inference(result)
            names = [str(n) for n in det.data.get("class_name", [])]
            classes.update(names)
            for name, conf in zip(names, det.confidence, strict=True):
                if conf < args.conf:
                    continue
                low = name.lower()
                if low in PERSON_WORDS:
                    counts["person"] += 1
                elif low in NO_VEST_WORDS:
                    counts["no_vest"] += 1
                elif low in VEST_WORDS:
                    counts["vest"] += 1
            labels = [f"{n} {c:.2f}" for n, c in zip(names, det.confidence, strict=True)]
            img = box.annotate(frame.copy(), det)
            sheets.append(label.annotate(img, det, labels))

        safe = re.sub(r"[^a-zA-Z0-9]+", "_", model)
        sheet_path = out_dir / f"{safe}.jpg"
        cv2.imwrite(str(sheet_path), contact_sheet(sheets))
        p50, p95 = np.percentile(timings, 50), np.percentile(timings, 95)
        print(f"   classes seen (conf>=0.2): {dict(classes) or 'none'}")
        print(f"   sheet: {sheet_path}")
        rows.append((model, counts["person"], counts["vest"], counts["no_vest"], p50, p95))

    print(f"\nOn {len(frames)} frames, counting boxes with confidence >= {args.conf}:")
    print(f"{'model':50} {'person':>6} {'vest':>5} {'no_vest':>7} {'p50 ms':>7} {'p95 ms':>7}")
    for m, p, v, nv, p50, p95 in rows:
        print(f"{m:50} {p:6d} {v:5d} {nv:7d} {p50:7.1f} {p95:7.1f}")


if __name__ == "__main__":
    main()
