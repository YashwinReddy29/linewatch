"""Outage drill: the web app goes down while incidents keep firing. Does any get lost?

    python bench/outage_drill.py --web http://localhost:3200 --incidents 50

1. Checks the web app is up.
2. Stops it (default: docker compose -p linewatch-bench stop web).
3. Writes N incidents into a real worker outbox (the same code the worker runs) while the
   web app is down; the sender keeps retrying with backoff.
4. Starts the web app again and times how long the outbox takes to empty.
5. Reads every page of GET /api/incidents: each incident must be stored exactly once.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import tempfile
import time
from pathlib import Path

import requests

from common import console_session, frame_jpegs, incident, machine, save, stored_ids, worker_token
from linewatch.outbox import Outbox
from linewatch.sink import HttpSender

COMPOSE = "docker compose -p linewatch-bench"


def wait_ready(web: str, timeout: float) -> float:
    start = time.perf_counter()
    while time.perf_counter() - start < timeout:
        try:
            if requests.get(f"{web}/api/readyz", timeout=2).status_code == 200:
                return time.perf_counter() - start
        except requests.RequestException:
            pass
        time.sleep(0.25)
    raise SystemExit(f"web app not ready after {timeout}s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default="http://localhost:3200")
    ap.add_argument("--incidents", type=int, default=50)
    ap.add_argument("--down-seconds", type=float, default=20, help="how long the web app stays down")
    ap.add_argument("--stop-cmd", default=f"{COMPOSE} stop web")
    ap.add_argument("--start-cmd", default=f"{COMPOSE} start web")
    args = ap.parse_args()

    wait_ready(args.web, 10)
    annotated, raw, _ = frame_jpegs()
    root = Path(tempfile.mkdtemp(prefix="linewatch-drill-"))
    outbox = Outbox(root, HttpSender(args.web, worker_token(), timeout=(1.0, 5.0)), base_backoff=0.5, max_backoff=4)

    print(f"stopping web app: {args.stop_cmd}")
    subprocess.run(shlex.split(args.stop_cmd), check=True)
    outbox.start()
    bodies = []
    interval = args.down_seconds / max(1, args.incidents)
    for n in range(args.incidents):
        body = incident(annotated, raw, n)
        bodies.append(body)
        outbox.put(body)
        time.sleep(interval)
    print(f"wrote {args.incidents} incidents while down; pending {outbox.pending_count()}, retries so far {outbox.retries}")

    print(f"starting web app: {args.start_cmd}")
    restart = time.perf_counter()
    subprocess.run(shlex.split(args.start_cmd), check=True)
    ready_after = wait_ready(args.web, 120)
    while outbox.pending_count() and time.perf_counter() - restart < 300:
        time.sleep(0.1)
    drained_after = time.perf_counter() - restart
    left = outbox.drain(timeout=5)

    seen = stored_ids(console_session(args.web), args.web, {b["id"] for b in bodies})
    result = {
        "benchmark": "outage_drill",
        "machine": machine(),
        "settings": vars(args),
        "incidents_written_while_down": len(bodies),
        "retries_during_outage": outbox.retries,
        "web_ready_after_restart_seconds": round(ready_after, 1),
        "outbox_empty_after_restart_seconds": round(drained_after, 1),
        "left_in_outbox": left,
        "dead_letters": outbox.dead,
        "incidents_stored": len(seen),
        "incidents_lost": len(bodies) - len(seen),
        "rows_per_incident_max": max(seen.values()) if seen else 0,
    }
    path = save("outage", result)
    print(f"retries while down: {outbox.retries}   web ready {ready_after:.1f} s after start, outbox empty after {drained_after:.1f} s")
    print(f"stored {len(seen)} of {len(bodies)}; lost {result['incidents_lost']}; dead letters {outbox.dead}; "
          f"max rows for one id {result['rows_per_incident_max']}")
    print(f"saved {path.relative_to(path.parents[2])}")
    if result["incidents_lost"] or result["rows_per_incident_max"] != 1 or left:
        raise SystemExit("FAIL: incidents were lost or stored twice")


if __name__ == "__main__":
    main()
