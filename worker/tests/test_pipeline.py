import numpy as np
import supervision as sv

from linewatch.pipeline import draw, judge

ZONE = [(0, 0), (500, 0), (500, 500), (0, 500)]


def people(boxes, ids):
    return sv.Detections(
        xyxy=np.array(boxes, dtype=float),
        confidence=np.full(len(boxes), 0.9),
        class_id=np.zeros(len(boxes), dtype=int),
        tracker_id=np.array(ids),
    )


def vests(boxes):
    if not boxes:
        return sv.Detections.empty()
    return sv.Detections(
        xyxy=np.array(boxes, dtype=float),
        confidence=np.full(len(boxes), 0.8),
        class_id=np.zeros(len(boxes), dtype=int),
    )


def test_person_in_zone_without_vest_is_violating():
    [s] = judge(people([[100, 100, 200, 400]], [1]), vests([]), ZONE, 0.5)
    assert s.in_zone and not s.has_vest and s.violating


def test_person_in_zone_with_vest_is_ok():
    [s] = judge(people([[100, 100, 200, 400]], [1]), vests([[120, 180, 180, 280]]), ZONE, 0.5)
    assert s.in_zone and s.has_vest and not s.violating


def test_person_outside_zone_is_never_violating():
    [s] = judge(people([[600, 100, 700, 400]], [1]), vests([]), ZONE, 0.5)
    assert not s.in_zone and not s.violating


def test_no_zone_means_no_violations():
    [s] = judge(people([[100, 100, 200, 400]], [1]), vests([]), None, 0.5)
    assert not s.violating


def test_unconfirmed_tracks_skipped():
    statuses = judge(people([[100, 100, 200, 400], [300, 100, 400, 400]], [-1, 2]), vests([]), ZONE, 0.5)
    assert [s.tracker_id for s in statuses] == [2]


def test_draw_returns_same_shape():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    statuses = judge(people([[100, 100, 200, 400]], [1]), vests([]), ZONE, 0.5)
    out = draw(frame, statuses, vests([]), ZONE, "Aisle 2", {1}, "hud")
    assert out.shape == frame.shape
    assert out.any()


def test_keep_classes_is_case_insensitive_and_thresholded():
    from linewatch.detector import keep_classes

    det = sv.Detections(
        xyxy=np.array([[0, 0, 1, 1], [0, 0, 2, 2], [0, 0, 3, 3], [0, 0, 4, 4]], dtype=float),
        confidence=np.array([0.9, 0.3, 0.8, 0.95]),
        class_id=np.array([0, 0, 1, 2]),
        data={"class_name": np.array(["Safety Vest", "Safety Vest", "Person", "NO-Safety Vest"])},
    )
    kept = keep_classes(det, ["safety vest", "vest"], 0.4)
    assert len(kept) == 1 and kept.confidence[0] == 0.9
    assert len(keep_classes(det, ["person"], 0.4)) == 1
    assert len(keep_classes(sv.Detections.empty(), ["person"], 0.4)) == 0


def test_logged_incident_does_not_keep_a_compliant_person_red():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    statuses = judge(people([[100, 100, 200, 400]], [1]), vests([[120, 180, 180, 280]]), ZONE, 0.5)
    out = draw(frame, statuses, vests([[120, 180, 180, 280]]), ZONE, "Aisle 2", {1}, "hud")
    # box edge pixel should be green (BGR 80,175,76), not red
    assert tuple(out[250, 100]) == (80, 175, 76)
