"""Summarize a worker run from its per-frame CSV (out/latency/run_*.csv).

    python eval/latency_report.py                 # latest run
    python eval/latency_report.py out/latency/run_20261017_024832.csv --skip 10

Reports the numbers you can honestly put in a README, with the machine they came from.
"""

from __future__ import annotations

import argparse
import csv
import glob
import platform
from pathlib import Path

import numpy as np


def cpu_name() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown CPU"


def summarize(rows: list[dict], skip: int) -> dict:
    rows = rows[skip:]
    if len(rows) < 2:
        raise SystemExit("Not enough frames after --skip. Let the worker run longer.")
    col = lambda k: np.array([float(r[k]) for r in rows])  # noqa: E731
    ts, infer, loop = col("ts"), col("infer_ms"), col("loop_ms")
    people, in_zone = col("people"), col("in_zone")
    duration = ts[-1] - ts[0]
    return {
        "frames": len(rows),
        "duration_s": duration,
        "fps": (len(rows) - 1) / duration if duration > 0 else 0.0,
        "infer_p50": np.percentile(infer, 50),
        "infer_p95": np.percentile(infer, 95),
        "loop_p50": np.percentile(loop, 50),
        "loop_p95": np.percentile(loop, 95),
        "person_p50": np.percentile(col("person_ms"), 50),
        "ppe_p50": np.percentile(col("ppe_ms"), 50),
        "frames_with_people": float((people > 0).mean()),
        "avg_people": float(people.mean()),
        "frames_with_someone_in_zone": float((in_zone > 0).mean()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", nargs="?", type=Path)
    parser.add_argument("--skip", type=int, default=10, help="warm-up frames to ignore")
    args = parser.parse_args()
    path = args.csv or Path(sorted(glob.glob("out/latency/run_*.csv"))[-1])
    rows = list(csv.DictReader(path.open()))
    s = summarize(rows, args.skip)
    print(f"Run: {path}  ({s['frames']} frames over {s['duration_s']:.0f} s, first {args.skip} skipped)")
    print(f"Machine: {cpu_name()}, {platform.system()} {platform.release()}")
    print(f"End-to-end throughput: {s['fps']:.2f} frames/s")
    print(
        f"Model time per frame (both models, parallel): "
        f"p50 {s['infer_p50']:.0f} ms, p95 {s['infer_p95']:.0f} ms"
    )
    print(f"  person model p50 {s['person_p50']:.0f} ms, PPE model p50 {s['ppe_p50']:.0f} ms")
    print(
        f"Full loop per frame (decode, infer, track, draw): "
        f"p50 {s['loop_p50']:.0f} ms, p95 {s['loop_p95']:.0f} ms"
    )
    print(
        f"Frames with at least one person: {s['frames_with_people'] * 100:.0f}%  "
        f"(avg {s['avg_people']:.2f}/frame)"
    )
    print(f"Frames with someone in the zone: {s['frames_with_someone_in_zone'] * 100:.0f}%")


if __name__ == "__main__":
    main()
