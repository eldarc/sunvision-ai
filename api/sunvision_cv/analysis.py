"""Pipeline orchestration: provider result (+ optional depth) -> FacadeAnalysis JSON.

The output matches `FacadeAnalysis` in web/src/schema/scene.ts. Extra keys
(`windowColumns`, row `slope`/`intercept`) are additive and ignored by the
type checker on the web side.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import numpy as np

from . import facade as fac
from .depth import DepthProvider, DepthResult, depth_info, encode_depth, median_depth_in_polygon
from .processing import ProcessingConfig, mask_at, process
from .providers import MODEL_CARD, ProviderResult

PIPELINE_VERSION = "sunvision-cv/1.0.0"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_analysis(
    provider_result: ProviderResult,
    image_rgb: np.ndarray | None = None,
    depth_provider: DepthProvider | None = None,
    depth_result: DepthResult | None = None,
    depth_url: str = "depth.png",
    depth_bin_url: str | None = "depth16.bin",
    confidence_threshold: float | None = None,
    inferred_at: str | None = None,
    cfg: ProcessingConfig | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Returns (analysis_json, depth_encoding_or_None)."""
    raw = provider_result.raw
    img_w, img_h = int(raw["image"]["width"]), int(raw["image"]["height"])
    warnings: list[str] = []
    if image_rgb is not None and (image_rgb.shape[1], image_rgb.shape[0]) != (img_w, img_h):
        warnings.append(
            f"inference image size {img_w}x{img_h} differs from supplied image "
            f"{image_rgb.shape[1]}x{image_rgb.shape[0]}; detections are in inference pixels"
        )

    det, detections = process(raw, cfg)
    windows = [d for d in detections if d["cls"] == "window"]
    primary = fac.select_primary_facade(detections, (img_w, img_h))

    roofline: list[dict[str, float]] = []
    groundline: list[dict[str, float]] = []
    if primary is not None:
        idx = [i for i, d in enumerate(detections) if d["id"] == primary["id"]][0]
        mask = mask_at(det, idx)
        if mask is not None:
            roofline, groundline, w = fac.extract_edge_lines(mask)
            warnings += w
        # restrict row clustering to windows on the primary facade when possible
        on_facade = [d for d in windows if fac._center_in(d["bbox"], primary["bbox"])]
        row_windows = on_facade if len(on_facade) >= 2 else windows
    else:
        row_windows = windows
        warnings.append("no facade detected")

    if not windows:
        warnings.append("no windows detected")
    if primary is None and not windows:
        warnings.append("no usable architectural features — use manual annotation")

    rows = fac.cluster_rows(row_windows)
    cols = fac.cluster_columns(row_windows)

    # ---- depth
    depth_enc = None
    depth_json = None
    if depth_result is None and depth_provider is not None and image_rgb is not None:
        try:
            depth_result = depth_provider.estimate(image_rgb)
        except Exception as exc:  # depth is optional; never fail the whole analysis
            warnings.append(f"depth estimation failed: {type(exc).__name__}: {exc}")
    if depth_result is not None:
        depth_enc = encode_depth(depth_result.depth)
        depth_json = depth_info(depth_enc, depth_result, depth_url, depth_bin_url, _now())
        for d in detections:
            m = median_depth_in_polygon(depth_result.depth, d.get("polygon"), d["bbox"], (img_w, img_h))
            if m is not None:
                d["depthMedian"] = round(m, 5)

    card = MODEL_CARD.get(provider_result.model_id, {})
    analysis: dict[str, Any] = {
        "model": {
            "provider": provider_result.provider,
            "modelId": provider_result.model_id,
            **({"architecture": card["architecture"]} if "architecture" in card else {}),
            **({"universeUrl": card["universeUrl"]} if "universeUrl" in card else {}),
            **({"license": card["license"]} if "license" in card else {}),
            **({"confidenceThreshold": confidence_threshold} if confidence_threshold is not None else {}),
            "inferredAt": inferred_at or _now(),
            "inferenceMs": round(provider_result.inference_ms, 1),
        },
        "imageWidth": img_w,
        "imageHeight": img_h,
        "detections": detections,
        **({"depth": depth_json} if depth_json else {}),
        "floorRows": rows,
        "windowColumns": cols,
        "roofline": roofline,
        "groundline": groundline,
        **({"primaryFacadeId": primary["id"]} if primary else {}),
        "classCounts": _counts(detections),
        "warnings": warnings,
        "pipelineVersion": PIPELINE_VERSION,
    }
    return analysis, depth_enc


def _counts(detections: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for d in detections:
        out[d["cls"]] = out.get(d["cls"], 0) + 1
    return out
