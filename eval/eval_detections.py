"""Detection accuracy on YOUR labeled test set: precision, recall and mAP@50 per class.

1. In Roboflow, create a project, upload ~100-150 frames from clips you did NOT tune on,
   label `person` and `vest` (model-assisted labeling makes this fast), and generate a version.
2. Export it as "COCO JSON" and unzip into eval/testset/ (it contains test/ or valid/ folders
   with images and _annotations.coco.json).
3. With the Inference server running:

    python eval/eval_detections.py eval/testset/test \
        --person-model rfdetr-small --ppe-model construction-site-safety/27

Each model's class names are mapped onto the test set's names (case-insensitive) with --map.
The numbers are only as good as the labels: say how many images and boxes in any write-up.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import supervision as sv
from dotenv import find_dotenv, load_dotenv
from supervision.metrics import MeanAveragePrecision

load_dotenv(find_dotenv(usecwd=True))

DEFAULT_MAP = {
    "person": "person",
    "safety vest": "vest",
    "vest": "vest",
}


@dataclass
class ClassScore:
    name: str
    tp: int
    fp: int
    fn: int

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else 0.0

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else 0.0


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (area_a[:, None] + area_b[None, :] - inter + 1e-9)


def match_counts(pred: np.ndarray, pred_conf: np.ndarray, gt: np.ndarray, iou: float) -> tuple[int, int, int]:
    """Greedy matching by confidence at one IoU threshold. Returns (tp, fp, fn)."""
    if len(pred) == 0:
        return 0, 0, len(gt)
    order = np.argsort(-pred_conf)
    ious = iou_matrix(pred[order], gt)
    used: set[int] = set()
    tp = 0
    for i in range(len(order)):
        if ious.shape[1] == 0:
            break
        candidates = [(ious[i, j], j) for j in range(ious.shape[1]) if j not in used and ious[i, j] >= iou]
        if candidates:
            used.add(max(candidates)[1])
            tp += 1
    return tp, len(pred) - tp, len(gt) - tp


def remap(det: sv.Detections, name_map: dict[str, str], target_classes: list[str]) -> sv.Detections:
    """Keep predictions whose class maps onto a test-set class and renumber class_id to match."""
    if len(det) == 0:
        return sv.Detections.empty()
    names = [str(n).lower() for n in det.data.get("class_name", [])]
    mapped = [name_map.get(n) for n in names]
    keep = np.array([m is not None and m in target_classes for m in mapped], dtype=bool)
    if not keep.any():
        return sv.Detections.empty()
    out = det[keep]
    out.class_id = np.array([target_classes.index(m) for m, k in zip(mapped, keep, strict=True) if k])
    return out


def evaluate(
    dataset: sv.DetectionDataset,
    predict: Callable[[np.ndarray], sv.Detections],
    conf: float,
    iou: float = 0.5,
) -> tuple[list[ClassScore], float, list[float]]:
    classes = dataset.classes
    totals = {c: [0, 0, 0] for c in range(len(classes))}
    preds_all, targets_all, timings = [], [], []
    for _, image, target in dataset:
        t = time.perf_counter()
        pred = predict(image)
        timings.append((time.perf_counter() - t) * 1000)
        preds_all.append(pred)
        targets_all.append(target)
        for c in range(len(classes)):
            p_mask = (pred.class_id == c) & (pred.confidence >= conf) if len(pred) else np.zeros(0, bool)
            g_mask = target.class_id == c if len(target) else np.zeros(0, bool)
            tp, fp, fn = match_counts(
                pred.xyxy[p_mask] if len(pred) else np.empty((0, 4)),
                pred.confidence[p_mask] if len(pred) else np.empty(0),
                target.xyxy[g_mask] if len(target) else np.empty((0, 4)),
                iou,
            )
            totals[c][0] += tp
            totals[c][1] += fp
            totals[c][2] += fn
    m = MeanAveragePrecision().update(preds_all, targets_all).compute()
    scores = [ClassScore(classes[c], *totals[c]) for c in range(len(classes))]
    return scores, float(m.map50), timings


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("split_dir", type=Path, help="folder with images and _annotations.coco.json")
    parser.add_argument("--person-model", default=os.environ.get("PERSON_MODEL_ID", "rfdetr-small"))
    parser.add_argument("--ppe-model", default=os.environ.get("PPE_MODEL_ID", "construction-site-safety/27"))
    parser.add_argument("--conf", type=float, default=0.35, help="confidence for precision/recall")
    parser.add_argument(
        "--map", nargs="*", default=[], help="extra model=testset class pairs, e.g. 'hi-viz vest=vest'"
    )
    parser.add_argument("--out", type=Path, default=Path("docs/results/detections.json"))
    args = parser.parse_args()

    from inference_sdk import InferenceConfiguration, InferenceHTTPClient

    name_map = dict(DEFAULT_MAP)
    for pair in args.map:
        k, v = pair.split("=", 1)
        name_map[k.strip().lower()] = v.strip()

    dataset = sv.DetectionDataset.from_coco(
        images_directory_path=str(args.split_dir),
        annotations_path=str(args.split_dir / "_annotations.coco.json"),
    )
    classes = [c.lower() for c in dataset.classes]
    dataset.classes = classes
    n_boxes = sum(len(t) for _, _, t in dataset)
    print(f"Test set: {len(dataset)} images, {n_boxes} labeled boxes, classes {classes}")

    client = InferenceHTTPClient(
        api_url=os.environ.get("INFERENCE_URL", "http://localhost:9001"),
        api_key=os.environ.get("ROBOFLOW_API_KEY", ""),
    )
    client.configure(InferenceConfiguration(confidence_threshold=0.05, api_key_transport="header"))
    models = list(dict.fromkeys([args.person_model, args.ppe_model]))

    def predict(image: np.ndarray) -> sv.Detections:
        parts = [
            remap(sv.Detections.from_inference(client.infer(image, model_id=m)), name_map, classes)
            for m in models
        ]
        parts = [p for p in parts if len(p)]
        return sv.Detections.merge(parts) if parts else sv.Detections.empty()

    for m in models:  # first call downloads weights; keep it out of the timings
        client.infer(next(iter(dataset))[1], model_id=m)

    scores, map50, timings = evaluate(dataset, predict, args.conf)
    print(f"\nModels: {', '.join(models)}   precision/recall at confidence >= {args.conf}, IoU >= 0.5")
    print(f"{'class':10} {'TP':>5} {'FP':>5} {'FN':>5} {'precision':>10} {'recall':>8}")
    for s in scores:
        if s.tp + s.fp + s.fn == 0:  # e.g. the empty parent class in Roboflow COCO exports
            continue
        print(f"{s.name:10} {s.tp:5d} {s.fp:5d} {s.fn:5d} {s.precision:10.3f} {s.recall:8.3f}")
    print(f"mAP@50 (all classes): {map50:.3f}")
    print(f"Inference per image (sequential calls): p50 {np.percentile(timings, 50):.0f} ms")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "models": models,
                "images": len(dataset),
                "boxes": n_boxes,
                "conf": args.conf,
                "iou": 0.5,
                "map50": map50,
                "classes": [s.__dict__ | {"precision": s.precision, "recall": s.recall} for s in scores],
                "p50_ms": float(np.percentile(timings, 50)),
            },
            indent=2,
        )
    )
    print(f"Saved {args.out}")


if __name__ == "__main__":
    main()
