"""Load test for POST /api/incidents: throughput, latency percentiles, duplicate handling.

    python bench/ingest_load.py --web http://localhost:3200 --incidents 500 --concurrency 8
    python bench/ingest_load.py --web http://localhost:3200 --incidents 200 --duplicates 3

Each request carries two full-size 1280x720 JPEGs (the worker's real payload).
With --duplicates k, every incident is POSTed k times at once (a retry storm): the web app
must store each exactly once. The script then reads every page of GET /api/incidents and
counts how many rows each id has.

Run it against the separate benchmark stack (make bench-up), never your real console:
it inserts N incidents.
"""

from __future__ import annotations

import argparse
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import requests

from common import console_session, frame_jpegs, incident, machine, save, stored_ids, summarize_ms, worker_token


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default="http://localhost:3200")
    ap.add_argument("--incidents", type=int, default=500)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--duplicates", type=int, default=1, help="send each incident k times concurrently")
    ap.add_argument("--warmup", type=int, default=20, help="requests sent first and not measured")
    args = ap.parse_args()

    token = worker_token()
    annotated, raw, jpeg_bytes = frame_jpegs()
    headers = {"Authorization": f"Bearer {token}"}
    local = __import__("threading").local()

    def post(body: dict) -> tuple[int, float]:
        if not hasattr(local, "s"):
            local.s = requests.Session()
        start = time.perf_counter()
        try:
            resp = local.s.post(f"{args.web}/api/incidents", json=body, headers={**headers, "X-Request-ID": body["id"]}, timeout=30)
            status = resp.status_code
        except requests.RequestException:
            status = 0
        return status, (time.perf_counter() - start) * 1000

    with ThreadPoolExecutor(args.concurrency) as pool:
        list(pool.map(post, [incident(annotated, raw) for _ in range(args.warmup)]))

        bodies = [incident(annotated, raw, n) for n in range(args.incidents)]
        jobs = [b for b in bodies for _ in range(args.duplicates)]
        start = time.perf_counter()
        results = list(pool.map(post, jobs))
        wall = time.perf_counter() - start

    statuses = Counter(s for s, _ in results)
    latencies = [ms for s, ms in results if s in (200, 201)]
    seen = stored_ids(console_session(args.web), args.web, {b["id"] for b in bodies})
    result = {
        "benchmark": "ingest_load",
        "machine": machine(),
        "settings": vars(args) | {"payload_jpeg_bytes": jpeg_bytes},
        "requests": len(jobs),
        "status_counts": {str(k): v for k, v in sorted(statuses.items())},
        "wall_seconds": round(wall, 2),
        "requests_per_second": round(len(jobs) / wall, 1),
        "latency_ms": summarize_ms(latencies) if latencies else None,
        "incidents_sent": len(bodies),
        "incidents_stored": len(seen),
        "rows_per_incident_max": max(seen.values()) if seen else 0,
        "duplicate_deliveries_absorbed": statuses.get(200, 0),
    }
    path = save("ingest", result)
    print(f"{len(jobs)} requests ({args.incidents} incidents x{args.duplicates}) at concurrency {args.concurrency}")
    print(f"  statuses: {result['status_counts']}   wall {result['wall_seconds']} s   {result['requests_per_second']} req/s")
    if latencies:
        lat = result["latency_ms"]
        print(f"  latency ms: mean {lat['mean']}  p50 {lat['p50']}  p95 {lat['p95']}  p99 {lat['p99']}  max {lat['max']}")
    print(f"  stored {len(seen)} of {len(bodies)} incidents; max rows for one id: {result['rows_per_incident_max']}")
    print(f"  saved {path.relative_to(path.parents[2])}")
    if len(seen) != len(bodies) or result["rows_per_incident_max"] != 1 or statuses.get(0):
        raise SystemExit("FAIL: an incident was lost, stored twice, or a request errored")


if __name__ == "__main__":
    main()
