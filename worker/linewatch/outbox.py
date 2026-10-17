"""Durable, ordered delivery of incidents to the web app.

Every incident is written to disk *before* any network call:

    out/outbox/pending/<time_ns>_<incident id>.json   waiting to be delivered (oldest first)
    out/outbox/dead/<same name>.json + .error.txt     rejected by the web app (dead letters)

A sender thread delivers the oldest pending file, then deletes it. If the web app is down,
the file stays and is retried with exponential backoff (with jitter) for as long as it takes,
including across worker restarts. A file the web app rejects outright (a 4xx other than
408/429: bad token, invalid payload) can never succeed by retrying, so it moves to dead/,
where `python -m linewatch.outbox replay` can put it back after the cause is fixed.

Delivery is at-least-once: a crash between "web app stored it" and "file deleted" re-sends
the file on restart. The web app makes that safe: the incident id is its idempotency key.
"""

from __future__ import annotations

import json
import logging
import os
import random
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

log = logging.getLogger("linewatch.outbox")


class Outcome(Enum):
    DELIVERED = "delivered"  # stored (or already stored) by the web app
    RETRY = "retry"  # transient: network error, timeout, 408, 429, 5xx
    DEAD = "dead"  # permanent: any other 4xx


@dataclass(frozen=True)
class Result:
    outcome: Outcome
    detail: str = ""


Sender = Callable[[dict], Result]


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class Outbox:
    def __init__(
        self,
        root: Path,
        send: Sender,
        *,
        base_backoff: float = 1.0,
        max_backoff: float = 30.0,
        on_result: Callable[[Outcome], None] | None = None,
    ) -> None:
        self.pending_dir = root / "pending"
        self.dead_dir = root / "dead"
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self.dead_dir.mkdir(parents=True, exist_ok=True)
        self._send = send
        self._base = base_backoff
        self._max = max_backoff
        self._on_result = on_result or (lambda _o: None)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.delivered = 0
        self.dead = 0
        self.retries = 0

    # ---------- writing ----------

    def put(self, payload: dict) -> Path:
        """Durably stores one payload (write temp, fsync, atomic rename) and wakes the sender."""
        name = f"{time.time_ns():020d}_{payload['id']}.json"
        final = self.pending_dir / name
        tmp = self.pending_dir / f".{name}.tmp"
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(payload, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, final)
        _fsync_dir(self.pending_dir)
        self._wake.set()
        return final

    def pending(self) -> list[Path]:
        return sorted(p for p in self.pending_dir.glob("*.json"))

    def pending_count(self) -> int:
        return len(self.pending())

    # ---------- sending ----------

    def start(self) -> None:
        if self._thread is None:
            backlog = self.pending_count()
            if backlog:
                log.info("Outbox has %s incident(s) from a previous run; delivering them first", backlog)
            self._thread = threading.Thread(target=self._run, daemon=True, name="outbox")
            self._thread.start()

    def _backoff(self, failures: int) -> float:
        delay = min(self._max, self._base * 2 ** max(0, failures - 1))
        return delay * (0.5 + random.random())  # noqa: S311 - jitter, not security

    def _to_dead(self, path: Path, reason: str) -> None:
        target = self.dead_dir / path.name
        os.replace(path, target)
        (self.dead_dir / f"{path.stem}.error.txt").write_text(reason + "\n", encoding="utf-8")
        self.dead += 1
        log.error("Incident %s moved to dead letters: %s", path.stem.split("_", 1)[-1], reason)

    def process_one(self) -> Outcome | None:
        """Tries to deliver the oldest pending file once. None when the outbox is empty."""
        files = self.pending()
        if not files:
            return None
        path = files[0]
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self._to_dead(path, f"unreadable outbox file: {exc}")
            self._on_result(Outcome.DEAD)
            return Outcome.DEAD
        result = self._send(payload)
        if result.outcome is Outcome.DELIVERED:
            path.unlink(missing_ok=True)
            self.delivered += 1
        elif result.outcome is Outcome.DEAD:
            self._to_dead(path, result.detail)
        else:
            self.retries += 1
        self._on_result(result.outcome)
        return result.outcome

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            outcome = self.process_one()
            if outcome is None:
                self._wake.wait(1.0)
                self._wake.clear()
            elif outcome is Outcome.RETRY:
                failures += 1
                delay = self._backoff(failures)
                log.warning(
                    "Web app unavailable; retrying in %.1fs (%s pending)", delay, self.pending_count()
                )
                self._stop.wait(delay)
            else:
                failures = 0

    def drain(self, timeout: float) -> int:
        """On shutdown: give the sender up to `timeout` s to empty the outbox. Returns what is left
        (it stays on disk and is delivered on the next start)."""
        deadline = time.monotonic() + timeout
        while self.pending_count() and time.monotonic() < deadline:
            time.sleep(0.1)
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)
        return self.pending_count()


def replay(root: Path) -> int:
    """Moves dead letters back to pending, oldest first. Returns how many."""
    dead = root / "dead"
    pending = root / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    moved = 0
    for path in sorted(dead.glob("*.json")):
        os.replace(path, pending / path.name)
        (dead / f"{path.stem}.error.txt").unlink(missing_ok=True)
        moved += 1
    return moved


if __name__ == "__main__":  # python -m linewatch.outbox [status|replay]
    root = Path(os.environ.get("OUT_DIR", "out")) / "outbox"
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "replay":
        print(f"Moved {replay(root)} dead letter(s) back to pending; the worker delivers them next.")
    else:
        pending = len(list((root / "pending").glob("*.json")))
        dead = sorted((root / "dead").glob("*.error.txt"))
        print(f"pending: {pending}  dead: {len(dead)}")
        for err in dead[:20]:
            print(f"  {err.stem.removesuffix('.error')}: {err.read_text(encoding='utf-8').strip()}")
