import numpy as np

from conftest import grid_windows
from sunvision_cv.facade import cluster_columns, cluster_rows, extract_edge_lines, floor_row_spacing, select_primary_facade


def _row_sets(rows):
    return [sorted(r["windowIds"]) for r in rows]


def test_rows_regular_grid():
    wins = grid_windows(5, 4)
    rows = cluster_rows(wins)
    assert len(rows) == 5
    assert rows[0]["index"] == 0 and rows[0]["yCenter"] > rows[-1]["yCenter"]  # bottom first
    assert sorted(rows[0]["windowIds"]) == [f"r4c{c}" for c in range(4)]
    assert abs(floor_row_spacing(rows) - 110) < 1


def test_rows_slanted_perspective():
    wins = grid_windows(4, 6, slope=0.25, jitter=2.0, seed=1)  # strong slope: rows overlap in plain y
    rows = cluster_rows(wins)
    assert len(rows) == 4
    for r in rows:
        assert len({wid.split("c")[0] for wid in r["windowIds"]}) == 1
        assert abs(r["slope"] - 0.25) < 0.05


def test_rows_missing_windows():
    drop = {(0, 0), (0, 1), (2, 3), (3, 0), (3, 2)}
    wins = grid_windows(4, 4, drop=drop, jitter=1.5, seed=2)
    rows = cluster_rows(wins)
    assert len(rows) == 4
    assert sum(len(r["windowIds"]) for r in rows) == 16 - len(drop)


def test_rows_single_window_and_empty():
    assert cluster_rows([]) == []
    rows = cluster_rows(grid_windows(1, 1))
    assert len(rows) == 1 and rows[0]["windowIds"] == ["r0c0"]


def test_columns():
    cols = cluster_columns(grid_windows(3, 5))
    assert len(cols) == 5


def test_edge_lines_synthetic_mask():
    mask = np.zeros((200, 300), dtype=bool)
    # trapezoid-ish facade: roof at y=40 on the left, sloping to y=60 on the right; ground at y=180
    for x in range(50, 251):
        top = int(40 + (x - 50) * 20 / 200)
        mask[top:181, x] = True
    mask[10:40, 140:145] = True  # chimney spike, should be median-filtered away
    roof, ground, warns = extract_edge_lines(mask, n_columns=41)
    assert len(roof) == 41 and len(ground) == 41
    ys = np.array([p["y"] for p in roof])
    xs = np.array([p["x"] for p in roof])
    expected = 40 + (xs - 50) * 20 / 200
    assert np.max(np.abs(ys - expected)) <= 2.0
    assert all(abs(p["y"] - 180) <= 1 for p in ground)
    assert warns == []


def test_edge_lines_cropped_top_warns():
    mask = np.zeros((100, 100), dtype=bool)
    mask[0:90, 10:90] = True
    _, _, warns = extract_edge_lines(mask)
    assert any("top image border" in w for w in warns)


def test_primary_facade_prefers_central_large():
    dets = [
        {"id": "a", "cls": "facade", "confidence": 0.9, "bbox": [0, 0, 60, 100]},
        {"id": "b", "cls": "facade", "confidence": 0.9, "bbox": [70, 0, 230, 100]},
    ]
    assert select_primary_facade(dets, (300, 100))["id"] == "b"
    assert select_primary_facade([], (300, 100)) is None
