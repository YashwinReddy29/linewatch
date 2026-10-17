"""Incident-level precision from your own reviews in the console.

Every incident you mark "Confirm incident" or "Mark as false alarm" is a labeled data point:
    precision = confirmed / (confirmed + false alarms)

    python eval/review_precision.py                     # web app on localhost:$WEB_PORT (default 3000)
    python eval/review_precision.py --web http://localhost:3000

Signs in with ADMIN_PASSWORD from .env (the API needs a session) and pages through every
incident. Recall needs ground truth this can't see: count by hand how many people actually
entered the zone without a vest in the clip, and compare with the number of confirmed incidents.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

import requests
from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))


def session_for(web: str) -> requests.Session:
    s = requests.Session()
    if os.environ.get("AUTH_DISABLED", "false").lower() == "true":
        return s
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not password:
        sys.exit("Set ADMIN_PASSWORD in .env (the console password) so this script can sign in.")
    resp = s.post(f"{web}/api/auth/login", json={"password": password}, timeout=5)
    if resp.status_code != 200:
        sys.exit(f"Sign-in failed: HTTP {resp.status_code} {resp.text[:200]}")
    return s


def all_incidents(s: requests.Session, web: str) -> list[dict]:
    incidents, cursor = [], None
    while True:
        params = {"status": "all", "limit": 200, **({"cursor": cursor} if cursor else {})}
        body = s.get(f"{web}/api/incidents", params=params, timeout=10).json()
        incidents += body["incidents"]
        cursor = body.get("nextCursor")
        if not cursor:
            return incidents


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--web", default=f"http://localhost:{os.environ.get('WEB_PORT', '3000')}")
    args = parser.parse_args()
    incidents = all_incidents(session_for(args.web), args.web)
    counts = Counter(i["status"] for i in incidents)
    reviewed = counts["confirmed"] + counts["false_alarm"]
    print(f"Incidents: {len(incidents)} total, {reviewed} reviewed, {counts['open']} still open")
    if reviewed == 0:
        print("Review some incidents in the console first.")
        return
    print(f"Confirmed {counts['confirmed']}, false alarms {counts['false_alarm']}")
    print(f"Incident precision: {counts['confirmed'] / reviewed:.2f} on {reviewed} reviewed incidents")
    sent = sum(1 for i in incidents if i["roboflowStatus"] == "uploaded")
    if counts["false_alarm"]:
        print(f"False alarms sent to Roboflow for relabeling: {sent} of {counts['false_alarm']}")


if __name__ == "__main__":
    main()
