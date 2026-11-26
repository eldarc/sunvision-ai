"""Raw Roboflow response -> filtered `sv.Detections` -> schema `Detection` dicts.

Uses Roboflow Supervision for parsing (`Detections.from_inference`), memory-
efficient masks (`CompactMask`), mask-IoU NMS (`with_nms`) and mask->polygon
conversion (`mask_to_polygons`).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
import supervision as sv

# Model scores below these are dropped. Values chosen conservatively; the UI
# shows the model score for every detection that survives.
DEFAULT_CLASS_THRESHOLDS: dict[str, float] = {
    "window": 0.35,
    "facade": 0.40,
    "balcony-fence": 0.35,
    "vegetation": 0.40,
    "shop": 0.40,
    "fence": 0.40,
    "car": 0.40,
    "street": 0.40,
    "non-building-infrastructure": 0.40,
    "traffic-infrastructure": 0.40,
}
FALLBACK_THRESHOLD = 0.40


@dataclass
class ProcessingConfig:
    class_thresholds: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_CLASS_THRESHOLDS))
    window_nms_iou: float = 0.5
    window_nested_ios: float = 0.85  # drop a window mostly contained in a higher-scoring one
    min_window_area_frac: float = 0.00003  # of image area
    min_window_rel_median: float = 0.08  # of median window area
    polygon_epsilon_frac: float = 0.004  # approxPolyDP epsilon as fraction of perimeter


def to_sv_detections(raw: dict[str, Any]) -> sv.Detections:
    """Parse a raw response with Supervision, keeping detection ids aligned."""
    preds = raw.get("predictions") or []
    det = sv.Detections.from_inference(raw, compact_masks=True)
    if len(det) == len(preds):
        det.data["detection_id"] = np.array(
            [p.get("detection_id") or f"det-{i}" for i, p in enumerate(preds)], dtype=object
        )
    else:  # defensive: should not happen for polygon responses
        det.data["detection_id"] = np.array([f"det-{i}" for i in range(len(det))], dtype=object)
    return det


def filter_detections(det: sv.Detections, image_wh: tuple[int, int], cfg: ProcessingConfig) -> sv.Detections:
    if len(det) == 0:
        return det
    names = det.data["class_name"]
    thr = np.array([cfg.class_thresholds.get(str(n), FALLBACK_THRESHOLD) for n in names])
    det = det[det.confidence >= thr]
    if len(det) == 0:
        return det

    is_win = det.data["class_name"] == "window"
    windows, others = det[is_win], det[~is_win]
    if len(windows):
        windows = windows.with_nms(threshold=cfg.window_nms_iou, class_agnostic=True)
        windows = windows.with_nms(
            threshold=cfg.window_nested_ios, class_agnostic=True, overlap_metric=sv.OverlapMetric.IOS
        )
        areas = windows.area.astype(float)
        w, h = image_wh
        min_area = max(cfg.min_window_area_frac * w * h, cfg.min_window_rel_median * float(np.median(areas)))
        windows = windows[areas >= min_area]
    if len(windows) and len(others):
        return sv.Detections.merge([others, windows])
    return windows if len(windows) else others


def mask_crop(det: sv.Detections, i: int) -> tuple[np.ndarray, tuple[int, int]] | None:
    """Mask of detection i as (crop, (x0, y0)) without densifying the full frame."""
    m = det.mask
    if m is None:
        return None
    if hasattr(m, "crop") and hasattr(m, "offsets"):  # sv CompactMask
        x0, y0 = (int(v) for v in m.offsets[i])
        return m.crop(i), (x0, y0)
    return np.asarray(m[i], dtype=bool), (0, 0)


def mask_at(det: sv.Detections, i: int) -> np.ndarray | None:
    """Full-frame dense mask for one detection."""
    mc = mask_crop(det, i)
    if mc is None:
        return None
    crop, (x0, y0) = mc
    if hasattr(det.mask, "image_shape"):
        h, w = det.mask.image_shape
    else:
        h, w = crop.shape
    out = np.zeros((h, w), dtype=bool)
    ch, cw = crop.shape
    out[y0 : y0 + ch, x0 : x0 + cw] = crop[: h - y0, : w - x0]
    return out


def simplify_polygon(mask: np.ndarray, eps_frac: float, offset: tuple[int, int] = (0, 0)) -> list[list[float]] | None:
    polys = sv.mask_to_polygons(mask)
    if not polys:
        return None
    poly = max(polys, key=lambda p: cv2.contourArea(p.astype(np.float32)))
    peri = cv2.arcLength(poly.reshape(-1, 1, 2).astype(np.float32), True)
    eps = max(0.75, eps_frac * peri)
    approx = cv2.approxPolyDP(poly.reshape(-1, 1, 2).astype(np.float32), eps, True).reshape(-1, 2)
    if len(approx) < 3:
        approx = poly
    ox, oy = offset
    return [[round(float(x) + ox, 1), round(float(y) + oy, 1)] for x, y in approx]


def to_schema(det: sv.Detections, cfg: ProcessingConfig) -> list[dict[str, Any]]:
    """Convert to `Detection` objects of web/src/schema/scene.ts."""
    out: list[dict[str, Any]] = []
    for i in range(len(det)):
        x1, y1, x2, y2 = (float(v) for v in det.xyxy[i])
        mc = mask_crop(det, i)
        poly = None
        if mc is not None and mc[0].any():
            # pad by 1px so contours touching the crop edge close correctly
            crop = np.pad(mc[0], 1)
            poly = simplify_polygon(crop, cfg.polygon_epsilon_frac, (mc[1][0] - 1, mc[1][1] - 1))
        out.append(
            {
                "id": str(det.data["detection_id"][i]),
                "cls": str(det.data["class_name"][i]),
                "confidence": round(float(det.confidence[i]), 4),
                "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                **({"polygon": poly} if poly else {}),
                "source": "model",
            }
        )
    return out


def process(raw: dict[str, Any], cfg: ProcessingConfig | None = None) -> tuple[sv.Detections, list[dict[str, Any]]]:
    cfg = cfg or ProcessingConfig()
    w = int(raw["image"]["width"])
    h = int(raw["image"]["height"])
    det = filter_detections(to_sv_detections(raw), (w, h), cfg)
    return det, to_schema(det, cfg)
