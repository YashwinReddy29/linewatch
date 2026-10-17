import numpy as np

from linewatch.geometry import coverage, denormalize, foot_point, point_in_polygon, wears_item

SQUARE = [(0, 0), (10, 0), (10, 10), (0, 10)]


def test_point_inside_and_outside_square():
    assert point_in_polygon(5, 5, SQUARE)
    assert not point_in_polygon(15, 5, SQUARE)
    assert not point_in_polygon(-1, -1, SQUARE)


def test_concave_polygon():
    # L-shape: the notch at (7, 7) is outside
    l_shape = [(0, 0), (10, 0), (10, 4), (4, 4), (4, 10), (0, 10)]
    assert point_in_polygon(2, 8, l_shape)
    assert not point_in_polygon(7, 7, l_shape)


def test_degenerate_polygon_is_never_inside():
    assert not point_in_polygon(1, 1, [(0, 0), (2, 2)])


def test_foot_point_is_bottom_center():
    assert foot_point((10, 20, 30, 100)) == (20.0, 100.0)


def test_denormalize():
    assert denormalize([[0.5, 0.25]], 200, 100) == [(100.0, 25.0)]


def test_coverage():
    assert coverage((0, 0, 10, 10), (0, 0, 20, 20)) == 1.0
    assert coverage((0, 0, 10, 10), (5, 0, 20, 20)) == 0.5
    assert coverage((0, 0, 10, 10), (50, 50, 60, 60)) == 0.0
    assert coverage((5, 5, 5, 5), (0, 0, 10, 10)) == 0.0  # zero-area box


def test_wears_item():
    person = (100, 100, 200, 400)
    vest_on_person = np.array([[120, 180, 180, 280]])
    vest_elsewhere = np.array([[500, 180, 560, 280]])
    assert wears_item(person, vest_on_person, 0.5)
    assert not wears_item(person, vest_elsewhere, 0.5)
    assert not wears_item(person, np.empty((0, 4)), 0.5)
