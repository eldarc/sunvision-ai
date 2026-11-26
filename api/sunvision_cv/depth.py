"""Monocular depth estimation providers.

Output is RELATIVE depth, never metres. Depth Anything V2 / V3 predict a
disparity-like quantity (larger = nearer). The browser calibrates it against
map distances (web/src/engine/reconstruct.ts); this module never pretends the
values are metric.

Providers
---------
* ``DepthAnythingV2Transformers`` – depth-anything/Depth-Anything-V2-Small-hf
  (Apache-2.0) via Hugging Face transformers. Runs locally on CPU or Apple MPS;
  weights are downloaded once from huggingface.co.
* ``InferenceModelsDepth`` – Roboflow `inference-models` AutoModel
  (`depth-anything-v3/small`, `depth-anything-v2/small`, ...). Per the official
  docs these pretrained ids require a Roboflow API key, so this provider is
  optional and only enabled when `inference-models` is installed and
  ROBOFLOW_API_KEY is set.
"""
from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass
from typing import Any, Protocol

import cv2
import numpy as np

MAX_DEPTH_SIDE = 640  # depth artefacts are downscaled so the browser can sample them cheaply


@dataclass
class DepthResult:
    depth: np.ndarray  # float32, H x W at the ORIGINAL image resolution or smaller
    kind: str  # 'relative-inverse' | 'relative' | 'metric'
    model: str
    provider: str
    inference_ms: float


class DepthProvider(Protocol):
    name: str

    def estimate(self, image_rgb: np.ndarray) -> DepthResult: ...


class DepthAnythingV2Transformers:
    name = "huggingface-transformers"
    _cache: dict[str, Any] = {}

    def __init__(self, model_id: str | None = None, device: str | None = None):
        self.model_id = model_id or os.environ.get("SUNVISION_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")
        self.device = device

    @staticmethod
    def available() -> bool:
        try:
            import torch  # noqa: F401
            import transformers  # noqa: F401
        except ImportError:
            return False
        return True

    def _load(self):
        if self.model_id in self._cache:
            return self._cache[self.model_id]
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        device = self.device or ("mps" if torch.backends.mps.is_available() else "cpu")
        processor = AutoImageProcessor.from_pretrained(self.model_id)
        model = AutoModelForDepthEstimation.from_pretrained(self.model_id).to(device).eval()
        self._cache[self.model_id] = (processor, model, device)
        return self._cache[self.model_id]

    def estimate(self, image_rgb: np.ndarray) -> DepthResult:
        import torch
        from PIL import Image

        processor, model, device = self._load()
        t0 = time.perf_counter()
        inputs = processor(images=Image.fromarray(image_rgb), return_tensors="pt").to(device)
        with torch.no_grad():
            pred = model(**inputs).predicted_depth  # (1, h, w)
        h, w = image_rgb.shape[:2]
        scale = min(1.0, MAX_DEPTH_SIDE / max(h, w))
        out_hw = (max(1, round(h * scale)), max(1, round(w * scale)))
        pred = torch.nn.functional.interpolate(pred.unsqueeze(1), size=out_hw, mode="bicubic", align_corners=False)
        depth = pred.squeeze().float().cpu().numpy().astype(np.float32)
        ms = (time.perf_counter() - t0) * 1000
        return DepthResult(depth, "relative-inverse", self.model_id, self.name, ms)


class InferenceModelsDepth:
    name = "roboflow-inference-models"

    def __init__(self, model_id: str = "depth-anything-v3/small", api_key: str | None = None):
        self.model_id = os.environ.get("SUNVISION_RF_DEPTH_MODEL", model_id)
        self.api_key = api_key or os.environ.get("ROBOFLOW_API_KEY") or None
        self._model = None

    @staticmethod
    def available() -> bool:
        try:
            import inference_models  # noqa: F401
        except ImportError:
            return False
        return bool(os.environ.get("ROBOFLOW_API_KEY"))

    def estimate(self, image_rgb: np.ndarray) -> DepthResult:
        from inference_models import AutoModel  # documented entrypoint

        if self._model is None:
            self._model = AutoModel.from_pretrained(self.model_id, api_key=self.api_key)
        bgr = np.ascontiguousarray(image_rgb[:, :, ::-1])
        t0 = time.perf_counter()
        depth = self._model(bgr)[0].cpu().numpy().astype(np.float32)
        ms = (time.perf_counter() - t0) * 1000
        h, w = depth.shape
        scale = min(1.0, MAX_DEPTH_SIDE / max(h, w))
        if scale < 1:
            depth = cv2.resize(depth, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        # Docs: "Relative depth values (not metric depth)". DA3 orientation is
        # not documented; we normalise so that larger = nearer by checking the
        # bottom (street, near) vs top rows heuristically and record it.
        kind = "relative-inverse"
        if np.median(depth[-max(1, h // 10):]) < np.median(depth[: max(1, h // 10)]):
            depth = depth.max() - depth
        return DepthResult(depth, kind, self.model_id, self.name, ms)


def default_depth_provider(prefer: str | None = None) -> DepthProvider | None:
    prefer = prefer or os.environ.get("SUNVISION_DEPTH_PROVIDER", "transformers")
    if prefer == "inference-models" and InferenceModelsDepth.available():
        return InferenceModelsDepth()
    if DepthAnythingV2Transformers.available():
        return DepthAnythingV2Transformers()
    if InferenceModelsDepth.available():
        return InferenceModelsDepth()
    return None


# ---------------------------------------------------------------- encoding

def encode_depth(depth: np.ndarray) -> dict[str, Any]:
    """Quantise to 16 bit. Returns png bytes, raw uint16 LE bytes and the range."""
    d = depth.astype(np.float64)
    lo, hi = float(np.nanmin(d)), float(np.nanmax(d))
    span = hi - lo if hi > lo else 1.0
    q = np.clip(np.round((d - lo) / span * 65535.0), 0, 65535).astype(np.uint16)
    ok, png = cv2.imencode(".png", q)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return {
        "png": png.tobytes(),
        "bin": q.astype("<u2").tobytes(order="C"),
        "rawMin": lo,
        "rawMax": hi,
        "width": int(q.shape[1]),
        "height": int(q.shape[0]),
    }


def depth_info(enc: dict[str, Any], result: DepthResult, url: str, bin_url: str | None, inferred_at: str) -> dict[str, Any]:
    info = {
        "url": url,
        "width": enc["width"],
        "height": enc["height"],
        "kind": result.kind,
        "rawMin": enc["rawMin"],
        "rawMax": enc["rawMax"],
        "bits": 16,
        "model": result.model,
        "provider": result.provider,
        "inferredAt": inferred_at,
        "inferenceMs": round(result.inference_ms, 1),
    }
    if bin_url:
        info["binUrl"] = bin_url
    return info


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def median_depth_in_polygon(depth: np.ndarray, polygon: list[list[float]] | None, bbox: list[float], image_wh: tuple[int, int]) -> float | None:
    """Median depth inside a detection, sampled on the (downscaled) depth grid."""
    dh, dw = depth.shape
    sx, sy = dw / image_wh[0], dh / image_wh[1]
    mask = np.zeros((dh, dw), dtype=np.uint8)
    if polygon and len(polygon) >= 3:
        pts = np.array([[x * sx, y * sy] for x, y in polygon], dtype=np.float32).round().astype(np.int32)
        cv2.fillPoly(mask, [pts], 1)
    if not mask.any():
        x1, y1, x2, y2 = bbox
        mask[int(y1 * sy) : max(int(y1 * sy) + 1, int(y2 * sy)), int(x1 * sx) : max(int(x1 * sx) + 1, int(x2 * sx))] = 1
    vals = depth[mask.astype(bool)]
    return float(np.median(vals)) if vals.size else None
