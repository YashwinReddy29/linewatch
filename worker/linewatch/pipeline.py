"""Per-frame judgment and drawing. Pure functions over numpy arrays."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
import supervision as sv

from .geometry import Point, foot_point, point_in_polygon, wears_item
from .rules import Observation

GREEN = (80, 175, 76)
RED = (54, 67, 244)
AMBER = (0, 170, 255)
GREY = (160, 160, 160)
ZONE = (255, 191, 0)


@dataclass(frozen=True)
class PersonStatus:
    tracker_id: int
    xyxy: tuple[float, float, float, float]
    confidence: float
    in_zone: bool
    has_vest: bool

    @property
    def violating(self) -> bool:
        return self.in_zone and not self.has_vest


def judge(
    people: sv.Detections,
    vests: sv.Detections,
    zone_px: list[Point] | None,
    vest_min_coverage: float,
) -> list[PersonStatus]:
    """Decide, for each tracked person, whether they are in the zone and wearing a vest."""
    statuses: list[PersonStatus] = []
    if len(people) == 0 or people.tracker_id is None:
        return statuses
    vest_boxes = vests.xyxy if len(vests) else np.empty((0, 4))
    for xyxy, conf, tid in zip(people.xyxy, people.confidence, people.tracker_id, strict=True):
        if tid is None or int(tid) < 0:
            continue
        box = tuple(float(v) for v in xyxy)
        fx, fy = foot_point(box)
        in_zone = bool(zone_px) and point_in_polygon(fx, fy, zone_px)
        statuses.append(
            PersonStatus(
                tracker_id=int(tid),
                xyxy=box,  # type: ignore[arg-type]
                confidence=float(conf),
                in_zone=in_zone,
                has_vest=wears_item(box, vest_boxes, vest_min_coverage),
            )
        )
    return statuses


def to_observations(statuses: list[PersonStatus]) -> list[Observation]:
    return [Observation(s.tracker_id, s.violating, s.confidence, s.xyxy) for s in statuses]


def _label(img: np.ndarray, text: str, x: int, y: int, color: tuple[int, int, int]) -> None:
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    y = max(y, th + 6)
    cv2.rectangle(img, (x, y - th - 6), (x + tw + 8, y), color, -1)
    cv2.putText(img, text, (x + 4, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)


def draw(
    frame: np.ndarray,
    statuses: list[PersonStatus],
    vests: sv.Detections,
    zone_px: list[Point] | None,
    zone_name: str | None,
    active_ids: set[int],
    hud: str,
) -> np.ndarray:
    out = frame.copy()
    if zone_px:
        pts = np.array(zone_px, dtype=np.int32)
        overlay = out.copy()
        cv2.fillPoly(overlay, [pts], ZONE)
        out = cv2.addWeighted(overlay, 0.15, out, 0.85, 0)
        cv2.polylines(out, [pts], True, ZONE, 2, cv2.LINE_AA)
        x, y = pts.min(axis=0)
        _label(out, zone_name or "Zone", int(x), int(y), (150, 110, 0))

    for x1, y1, x2, y2 in vests.xyxy if len(vests) else []:
        cv2.rectangle(out, (int(x1), int(y1)), (int(x2), int(y2)), AMBER, 1)

    for s in statuses:
        x1, y1, x2, y2 = (int(v) for v in s.xyxy)
        # Colour shows what is true now; an incident already logged doesn't keep a
        # person red after their vest is detected again.
        if s.violating and s.tracker_id in active_ids:
            color, text, thick = RED, f"#{s.tracker_id} no vest - incident", 3
        elif s.violating:
            color, text, thick = AMBER, f"#{s.tracker_id} no vest?", 2
        elif s.in_zone:
            color, text, thick = GREEN, f"#{s.tracker_id} vest ok", 2
        else:
            color, text, thick = GREY, f"#{s.tracker_id}", 1
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thick)
        _label(out, text, x1, y1, color)

    if not zone_px:
        hud = "No zone set: draw one to start monitoring  |  " + hud
    cv2.rectangle(out, (0, out.shape[0] - 28), (out.shape[1], out.shape[0]), (30, 30, 30), -1)
    cv2.putText(
        out, hud, (10, out.shape[0] - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (235, 235, 235), 1, cv2.LINE_AA
    )
    return out
