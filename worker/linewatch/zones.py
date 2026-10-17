"""Where the monitored zone comes from.

With WEB_URL set, the worker polls the web app so a zone drawn in the
browser takes effect within seconds, no restart. Without it, the zone is
read from a local JSON file (handy for running the worker alone).
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import requests

log = logging.getLogger("linewatch.zones")


@dataclass(frozen=True)
class Zone:
    id: str
    name: str
    points: list[list[float]]  # normalized 0..1 [x, y]


def _parse(data: dict | None) -> Zone | None:
    if not data or len(data.get("points", [])) < 3:
        return None
    return Zone(
        id=str(data.get("id", "local")),
        name=str(data.get("name", "Zone")),
        points=[[float(x), float(y)] for x, y in data["points"]],
    )


class ZoneProvider:
    def __init__(self, web_url: str, zone_file: Path, poll_seconds: float, token: str = "") -> None:
        self.web_url = web_url
        self.zone_file = zone_file
        self.poll_seconds = poll_seconds
        self.token = token
        self._zone: Zone | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.last_error: str | None = None

        if web_url:
            self._fetch_remote()
            threading.Thread(target=self._poll, daemon=True, name="zones").start()
        else:
            self._zone = self._load_file()

    @property
    def current(self) -> Zone | None:
        with self._lock:
            return self._zone

    def _load_file(self) -> Zone | None:
        if not self.zone_file.exists():
            log.warning("No zone file at %s; nothing will be flagged until a zone exists.", self.zone_file)
            return None
        return _parse(json.loads(self.zone_file.read_text()))

    def _fetch_remote(self) -> None:
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            resp = requests.get(f"{self.web_url}/api/zones/active", headers=headers, timeout=3)
            resp.raise_for_status()
            zone = _parse(resp.json().get("zone"))
            with self._lock:
                if zone != self._zone:
                    log.info("Zone updated: %s", zone.name if zone else "none")
                self._zone = zone
            self.last_error = None
        except (requests.RequestException, ValueError) as exc:
            # Keep the last good zone; the web app may just be restarting.
            self.last_error = str(exc)

    def _poll(self) -> None:
        while not self._stop.wait(self.poll_seconds):
            self._fetch_remote()

    def stop(self) -> None:
        self._stop.set()
