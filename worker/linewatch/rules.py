"""Turns noisy per-frame judgments into one incident per person.

A detector flickers: a vest is found in 9 frames and missed in the 10th.
Raw per-frame alerts would fire hundreds of times for one person. Instead,
each tracked person gets a sliding window of recent frames, and an incident
fires only when at least `min_violating` of the last `window` frames were
violations. The incident stays "active" (no repeat alerts) until the window
is completely clean again, or the track goes stale.
"""

from __future__ import annotations

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


@dataclass
class ViolationTracker:
    window: int = 8
    min_violating: int = 6
    stale_seconds: float = 10.0
    # A detector that flickers can clear and re-fill the window for the same person.
    # The cooldown caps it at one incident per person per `cooldown_seconds`.
    cooldown_seconds: float = 60.0
    _tracks: dict[int, _TrackState] = field(default_factory=dict)

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

            violating_count = sum(state.flags)
            cooling_down = (
                state.last_incident_at is not None and now - state.last_incident_at < self.cooldown_seconds
            )
            if not state.active and violating_count >= self.min_violating and not cooling_down:
                state.active = True
                state.last_incident_at = now
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

        self._drop_stale(now)
        return incidents

    def is_active(self, tracker_id: int) -> bool:
        state = self._tracks.get(tracker_id)
        return bool(state and state.active)

    def _drop_stale(self, now: float) -> None:
        stale = [tid for tid, s in self._tracks.items() if now - s.last_seen > self.stale_seconds]
        for tid in stale:
            del self._tracks[tid]

    def __len__(self) -> int:
        return len(self._tracks)
