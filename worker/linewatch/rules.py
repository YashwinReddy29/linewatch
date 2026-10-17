"""Turns noisy per-frame judgments into one incident per person.

A detector flickers: a vest is found in 9 frames and missed in the 10th.
Raw per-frame alerts would fire hundreds of times for one person. Instead,
each tracked person gets a sliding window of recent frames, and an incident
fires only when at least `min_violating` of the last `window` frames were
violations. The incident stays "active" (no repeat alerts) until the window
is completely clean again, or the track goes stale.

Trackers also lose small, distant people and re-find them under a new ID.
Each new ID would start its own window and raise a second incident for the
same worker. So a track that is about to fire near an incident that is still
live (its person was seen within `dedupe_seconds`, within `dedupe_radius`
person-heights) joins that incident instead of raising a new one.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Observation:
    tracker_id: int
    violating: bool
    confidence: float
    xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class Incident:
    tracker_id: int
    started_at: float  # time of the first violating frame in the window
    triggered_at: float  # time the rule fired
    violating_frames: int
    window_frames: int
    confidence: float  # best person confidence seen while violating
    xyxy: tuple[float, float, float, float]

    @property
    def duration_s(self) -> float:
        return self.triggered_at - self.started_at


@dataclass
class _TrackState:
    flags: deque
    times: deque
    active: bool = False
    last_seen: float = 0.0
    best_confidence: float = 0.0
    last_incident_at: float | None = None
    linked: _LiveIncident | None = None


@dataclass(eq=False)  # compared by identity: two people can stand at the same spot
class _LiveIncident:
    """Where the person behind an incident was last seen: feet (x, y), box height, time."""

    x: float
    y: float
    height: float
    seen_at: float


def _feet(xyxy: tuple[float, float, float, float]) -> tuple[float, float, float]:
    x1, y1, x2, y2 = xyxy
    return (x1 + x2) / 2, y2, max(y2 - y1, 1e-9)


@dataclass
class ViolationTracker:
    window: int = 8
    min_violating: int = 6
    stale_seconds: float = 10.0
    # A detector that flickers can clear and re-fill the window for the same person.
    # The cooldown caps it at one incident per person per `cooldown_seconds`.
    cooldown_seconds: float = 60.0
    # Re-ID merge: 0 radius turns it off.
    dedupe_radius: float = 1.0
    dedupe_seconds: float = 15.0
    suppressed: int = 0  # incidents merged into an earlier one, for logging
    _tracks: dict[int, _TrackState] = field(default_factory=dict)
    _live: list[_LiveIncident] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not 1 <= self.min_violating <= self.window:
            raise ValueError("min_violating must be between 1 and window")

    def update(self, observations: list[Observation], now: float) -> list[Incident]:
        incidents: list[Incident] = []
        for obs in observations:
            if obs.tracker_id < 0:
                # Unconfirmed tracks share id -1; never let them merge into one person.
                continue
            state = self._tracks.get(obs.tracker_id)
            if state is None:
                state = _TrackState(flags=deque(maxlen=self.window), times=deque(maxlen=self.window))
                self._tracks[obs.tracker_id] = state
            state.flags.append(obs.violating)
            state.times.append(now)
            state.last_seen = now
            if obs.violating:
                state.best_confidence = max(state.best_confidence, obs.confidence)
            if state.linked is not None:
                x, y, h = _feet(obs.xyxy)
                state.linked.x, state.linked.y, state.linked.height, state.linked.seen_at = x, y, h, now

            violating_count = sum(state.flags)
            cooling_down = (
                state.last_incident_at is not None and now - state.last_incident_at < self.cooldown_seconds
            )
            if not state.active and violating_count >= self.min_violating and not cooling_down:
                state.active = True
                state.last_incident_at = now
                duplicate_of = self._nearby_live(obs.xyxy, now)
                if duplicate_of is not None:
                    state.linked = duplicate_of
                    duplicate_of.seen_at = now
                    self.suppressed += 1
                    continue
                x, y, h = _feet(obs.xyxy)
                state.linked = _LiveIncident(x, y, h, now)
                self._live.append(state.linked)
                first_violation = next(t for t, f in zip(state.times, state.flags, strict=True) if f)
                incidents.append(
                    Incident(
                        tracker_id=obs.tracker_id,
                        started_at=first_violation,
                        triggered_at=now,
                        violating_frames=violating_count,
                        window_frames=len(state.flags),
                        confidence=state.best_confidence,
                        xyxy=obs.xyxy,
                    )
                )
            elif state.active and violating_count == 0:
                state.active = False
                state.best_confidence = 0.0
                # The person was seen clean for a whole window: that incident is over.
                if state.linked in self._live:
                    self._live.remove(state.linked)
                state.linked = None

        self._drop_stale(now)
        return incidents

    def _nearby_live(self, xyxy: tuple[float, float, float, float], now: float) -> _LiveIncident | None:
        if self.dedupe_radius <= 0:
            return None
        x, y, h = _feet(xyxy)
        for live in self._live:
            if now - live.seen_at > self.dedupe_seconds:
                continue
            if math.hypot(x - live.x, y - live.y) <= self.dedupe_radius * max(h, live.height):
                return live
        return None

    def is_active(self, tracker_id: int) -> bool:
        state = self._tracks.get(tracker_id)
        return bool(state and state.active)

    def _drop_stale(self, now: float) -> None:
        stale = [tid for tid, s in self._tracks.items() if now - s.last_seen > self.stale_seconds]
        for tid in stale:
            del self._tracks[tid]
        self._live = [live for live in self._live if now - live.seen_at <= self.dedupe_seconds]

    def __len__(self) -> int:
        return len(self._tracks)
