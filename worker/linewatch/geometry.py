"""Pure geometry helpers. No I/O, fully unit tested."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

Point = tuple[float, float]


def point_in_polygon(x: float, y: float, polygon: Sequence[Point]) -> bool:
    """Ray casting. Points exactly on an edge may land either side; fine for our use."""
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def foot_point(xyxy: Sequence[float]) -> Point:
    """Bottom-center of a box: where a person stands on the floor."""
    x1, _, x2, y2 = xyxy
    return ((x1 + x2) / 2.0, float(y2))


def denormalize(points: Sequence[Sequence[float]], width: int, height: int) -> list[Point]:
    """Zone points are stored as 0..1 fractions so they survive resolution changes."""
    return [(float(px) * width, float(py) * height) for px, py in points]


def coverage(inner: Sequence[float], outer: Sequence[float]) -> float:
    """Fraction of the inner box's area that lies inside the outer box."""
    ix1, iy1, ix2, iy2 = inner
    ox1, oy1, ox2, oy2 = outer
    inner_area = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inner_area == 0:
        return 0.0
    w = max(0.0, min(ix2, ox2) - max(ix1, ox1))
    h = max(0.0, min(iy2, oy2) - max(iy1, oy1))
    return (w * h) / inner_area


def wears_item(person_xyxy: Sequence[float], items_xyxy: np.ndarray, min_coverage: float) -> bool:
    """True if any item box (e.g. a vest) sits mostly inside the person box."""
    for item in np.asarray(items_xyxy).reshape(-1, 4):
        if coverage(item, person_xyxy) >= min_coverage:
            return True
    return False
