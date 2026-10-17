import pytest

from linewatch.rules import Observation, ViolationTracker

BOX = (0.0, 0.0, 10.0, 10.0)


def obs(tid: int, violating: bool, conf: float = 0.9) -> Observation:
    return Observation(tid, violating, conf, BOX)


def feed(tracker: ViolationTracker, pattern: str, tid: int = 1, start: float = 0.0):
    """pattern: 'x' = violating frame, '.' = clean frame. Returns all incidents."""
    incidents = []
    for i, ch in enumerate(pattern):
        incidents += tracker.update([obs(tid, ch == "x")], now=start + i)
    return incidents


def test_steady_violation_fires_exactly_once():
    t = ViolationTracker(window=8, min_violating=6)
    incidents = feed(t, "x" * 50)
    assert len(incidents) == 1
    assert incidents[0].triggered_at == 5  # 6th violating frame
    assert incidents[0].started_at == 0
    assert incidents[0].duration_s == 5


def test_flicker_does_not_fire():
    t = ViolationTracker(window=8, min_violating=6)
    assert feed(t, "x.x.x.x.x.x.x.x.") == []


def test_one_missed_detection_still_fires_once():
    t = ViolationTracker(window=8, min_violating=6)
    incidents = feed(t, "xxx.xxxxxxxxxxxx")
    assert len(incidents) == 1


def test_new_incident_only_after_window_is_clean():
    t = ViolationTracker(window=4, min_violating=3)
    # fire, partial clean (still active), more violation -> no repeat
    assert len(feed(t, "xxx..xx")) == 1
    t2 = ViolationTracker(window=4, min_violating=3, cooldown_seconds=0)
    # fire, fully clean window resets, violate again -> second incident
    assert len(feed(t2, "xxx" + "...." + "xxx")) == 2


def test_tracks_are_independent():
    t = ViolationTracker(window=4, min_violating=3)
    incidents = []
    for i in range(5):
        incidents += t.update([obs(1, True), obs(2, False)], now=i)
    assert [inc.tracker_id for inc in incidents] == [1]


def test_unconfirmed_tracks_are_ignored():
    t = ViolationTracker(window=4, min_violating=3)
    incidents = []
    for i in range(10):
        incidents += t.update([obs(-1, True)], now=i)
    assert incidents == []
    assert len(t) == 0


def test_stale_tracks_are_dropped():
    t = ViolationTracker(window=4, min_violating=3, stale_seconds=5)
    t.update([obs(1, False)], now=0)
    t.update([obs(2, False)], now=10)
    assert len(t) == 1


def test_best_confidence_is_reported():
    t = ViolationTracker(window=4, min_violating=3)
    t.update([obs(1, True, 0.5)], now=0)
    t.update([obs(1, True, 0.8)], now=1)
    [incident] = t.update([obs(1, True, 0.6)], now=2)
    assert incident.confidence == 0.8


def test_invalid_config_rejected():
    with pytest.raises(ValueError):
        ViolationTracker(window=4, min_violating=5)


def test_cooldown_blocks_repeat_incident_for_same_person():
    t = ViolationTracker(window=4, min_violating=3, cooldown_seconds=60)
    # fires at t=2, clears, violates again at t=7..9: still inside the 60 s cooldown
    assert len(feed(t, "xxx" + "...." + "xxx")) == 1
    t2 = ViolationTracker(window=4, min_violating=3, cooldown_seconds=60)
    feed(t2, "xxx" + "....", start=0)
    # after the cooldown, a new violation may fire again
    again = feed(t2, "xxx", start=100)
    assert len(again) == 1
