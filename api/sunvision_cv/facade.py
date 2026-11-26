"""Architectural feature extraction from processed detections.

* primary facade selection
* roofline / groundline extraction from the facade mask
* window floor-row clustering (robust to perspective slope and missing windows)
* window column clustering

Everything here is IMAGE-SPACE geometry. Converting rows into metric floor
heights needs camera calibration and happens in the browser
(web/src/engine/reconstruct.ts), so manual corrections propagate instantly.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np


# ---------------------------------------------------------------- primary facade

def select_primary_facade(detections: Sequence[dict[str, Any]], image_wh: tuple[int, int]) -> dict[str, Any] | None:
    """Largest facade weighted by horizontal centrality and the windows it contains."""
    w, _ = image_wh
    facades = [d for d in detections if d["cls"] == "facade"]
    if not facades:
        return None
    windows = [d for d in detections if d["cls"] == "window"]

    def score(f: dict[str, Any]) -> float:
        x1, y1, x2, y2 = f["bbox"]
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        cx = 0.5 * (x1 + x2)
        centrality = 1.0 - 0.5 * min(1.0, abs(cx - w / 2) / (w / 2))
        inside = sum(1 for d in windows if _center_in(d["bbox"], f["bbox"]))
        return area * centrality * (1.0 + 0.05 * inside) * f["confidence"]

    return max(facades, key=score)


def _center_in(b: Sequence[float], box: Sequence[float]) -> bool:
    cx, cy = 0.5 * (b[0] + b[2]), 0.5 * (b[1] + b[3])
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


# ---------------------------------------------------------------- roof / ground lines

def _median_filter_1d(values: np.ndarray, k: int = 5) -> np.ndarray:
    if len(values) < 3:
        return values
    k = min(k, len(values) if len(values) % 2 == 1 else len(values) - 1)
    pad = k // 2
    padded = np.pad(values, pad, mode="edge")
    return np.array([np.median(padded[i : i + k]) for i in range(len(values))])


def extract_edge_lines(
    mask: np.ndarray, n_columns: int = 40, x_range: tuple[int, int] | None = None
) -> tuple[list[dict[str, float]], list[dict[str, float]], list[str]]:
    """Per sampled column: topmost (roofline) and bottommost (groundline) mask pixel.

    Returns (roofline, groundline, warnings). Points are in image pixels.
    """
    warnings: list[str] = []
    h, w = mask.shape
    cols_any = np.flatnonzero(mask.any(axis=0))
    if len(cols_any) == 0:
        return [], [], ["facade mask is empty"]
    x0, x1 = x_range if x_range else (int(cols_any[0]), int(cols_any[-1]))
    xs = np.unique(np.linspace(x0, x1, num=max(2, n_columns)).round().astype(int))
    tops, bottoms, keep = [], [], []
    for x in xs:
        col = np.flatnonzero(mask[:, min(max(x, 0), w - 1)])
        if len(col) == 0:
            continue
        tops.append(col[0])
        bottoms.append(col[-1])
        keep.append(x)
    if not keep:
        return [], [], ["facade mask has no pixels in sampled columns"]
    tops_f = _median_filter_1d(np.array(tops, dtype=float))
    bots_f = _median_filter_1d(np.array(bottoms, dtype=float))
    if np.mean(tops_f <= 1) > 0.3:
        warnings.append("facade touches the top image border: the roofline may be cropped, height is a lower bound")
    if np.mean(bots_f >= h - 2) > 0.3:
        warnings.append("facade touches the bottom image border: the ground line may be cropped")
    roof = [{"x": float(x), "y": float(y)} for x, y in zip(keep, tops_f)]
    ground = [{"x": float(x), "y": float(y)} for x, y in zip(keep, bots_f)]
    return roof, ground, warnings


# ---------------------------------------------------------------- floor rows

@dataclass
class _Win:
    id: str
    cx: float
    cy: float
    w: float
    h: float
    y1: float
    y2: float


def _wins(windows: Sequence[dict[str, Any]]) -> list[_Win]:
    out = []
    for d in windows:
        x1, y1, x2, y2 = d["bbox"]
        out.append(_Win(d["id"], 0.5 * (x1 + x2), 0.5 * (y1 + y2), x2 - x1, y2 - y1, y1, y2))
    return out


def theil_sen(xs: np.ndarray, ys: np.ndarray, max_abs_slope: float = 0.35) -> tuple[float, float]:
    """Robust line fit y = a*x + b. Falls back to horizontal for <2 points."""
    if len(xs) < 2 or np.ptp(xs) < 1e-6:
        return 0.0, float(np.median(ys))
    i, j = np.triu_indices(len(xs), k=1)
    dx = xs[j] - xs[i]
    ok = np.abs(dx) > 1e-6
    slopes = (ys[j][ok] - ys[i][ok]) / dx[ok]
    a = float(np.clip(np.median(slopes), -max_abs_slope, max_abs_slope)) if len(slopes) else 0.0
    b = float(np.median(ys - a * xs))
    return a, b


def _global_slope(wins: list[_Win], med_h: float) -> float:
    """Median slope between window pairs that plausibly share a row."""
    slopes = []
    for a in range(len(wins)):
        for b in range(a + 1, len(wins)):
            p, q = wins[a], wins[b]
            dx = q.cx - p.cx
            if abs(dx) < 0.5 * max(p.w, q.w):
                continue
            if abs(q.cy - p.cy) < 0.6 * med_h:
                slopes.append((q.cy - p.cy) / dx)
    return float(np.median(slopes)) if slopes else 0.0


def cluster_rows(
    windows: Sequence[dict[str, Any]], gap_frac: float = 0.55, merge_frac: float = 0.4
) -> list[dict[str, Any]]:
    """Cluster window centres into floor rows.

    1. estimate a dominant row slope from window pairs (perspective / roll);
    2. 1-D gap clustering of slope-corrected y with a gap threshold relative to
       the median window height;
    3. per-row Theil–Sen line fit, re-assignment of windows to the nearest row
       line, and merging of rows whose lines nearly coincide.

    Returns rows sorted bottom (index 0, largest image y) to top.
    """
    wins = _wins(windows)
    if not wins:
        return []
    med_h = float(np.median([w.h for w in wins]))
    xref = float(np.median([w.cx for w in wins]))
    slope = _global_slope(wins, med_h)
    corrected = np.array([w.cy - slope * (w.cx - xref) for w in wins])
    order = np.argsort(corrected)
    groups: list[list[int]] = [[int(order[0])]]
    for prev, cur in zip(order[:-1], order[1:]):
        if corrected[cur] - corrected[prev] > gap_frac * med_h:
            groups.append([])
        groups[-1].append(int(cur))

    def fit(group: list[int]) -> tuple[float, float]:
        xs = np.array([wins[i].cx for i in group])
        ys = np.array([wins[i].cy for i in group])
        if len(group) >= 3:
            return theil_sen(xs, ys)
        # too few points for a reliable line: use the global slope
        return slope, float(np.median(ys - slope * xs))

    for _ in range(2):
        lines = [fit(g) for g in groups if g]
        # re-assign each window to the closest row line
        new_groups: list[list[int]] = [[] for _ in lines]
        for i, w in enumerate(wins):
            d = [abs(w.cy - (a * w.cx + b)) for a, b in lines]
            new_groups[int(np.argmin(d))].append(i)
        groups = [g for g in new_groups if g]
        # merge rows whose lines coincide at the reference x
        groups.sort(key=lambda g: np.median([wins[i].cy for i in g]))
        merged: list[list[int]] = []
        for g in groups:
            if merged:
                a0, b0 = fit(merged[-1])
                a1, b1 = fit(g)
                if abs((a0 * xref + b0) - (a1 * xref + b1)) < merge_frac * med_h:
                    merged[-1].extend(g)
                    continue
            merged.append(g)
        groups = merged

    rows = []
    for g in groups:
        a, b = fit(g)
        rows.append(
            {
                "yCenter": round(a * xref + b, 2),
                "yMin": round(min(wins[i].y1 for i in g), 2),
                "yMax": round(max(wins[i].y2 for i in g), 2),
                "windowIds": [wins[i].id for i in sorted(g, key=lambda i: wins[i].cx)],
                "slope": round(a, 5),
                "intercept": round(b, 3),
                "medianWindowHeight": round(float(np.median([wins[i].h for i in g])), 2),
            }
        )
    rows.sort(key=lambda r: -r["yCenter"])  # bottom first
    for idx, r in enumerate(rows):
        r["index"] = idx
    return [{"index": r.pop("index"), **r} for r in rows]


def cluster_columns(windows: Sequence[dict[str, Any]], gap_frac: float = 0.6) -> list[dict[str, Any]]:
    wins = _wins(windows)
    if not wins:
        return []
    med_w = float(np.median([w.w for w in wins]))
    order = sorted(range(len(wins)), key=lambda i: wins[i].cx)
    groups: list[list[int]] = [[order[0]]]
    for prev, cur in zip(order[:-1], order[1:]):
        if wins[cur].cx - wins[prev].cx > gap_frac * med_w:
            groups.append([])
        groups[-1].append(cur)
    return [
        {
            "index": k,
            "xCenter": round(float(np.median([wins[i].cx for i in g])), 2),
            "windowIds": [wins[i].id for i in g],
        }
        for k, g in enumerate(groups)
    ]


def floor_row_spacing(rows: Sequence[dict[str, Any]]) -> float | None:
    """Median pixel spacing between consecutive rows (bottom-to-top), or None."""
    if len(rows) < 2:
        return None
    ys = sorted((r["yCenter"] for r in rows), reverse=True)
    return float(np.median(-np.diff(ys)))
