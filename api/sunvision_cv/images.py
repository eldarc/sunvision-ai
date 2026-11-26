"""Upload validation and privacy-preserving image preparation."""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_INFERENCE_SIDE = 2048
ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}

# Guard PIL against decompression bombs beyond our own limit.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS * 2


class ImageValidationError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "invalid_image"):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass
class PreparedImage:
    rgb: np.ndarray  # EXIF-free, orientation-corrected, downscaled RGB uint8
    original_width: int  # after orientation correction (what browsers display)
    original_height: int
    scale: float  # rgb pixels = original pixels * scale
    format: str


def prepare_upload(data: bytes, max_side: int = MAX_INFERENCE_SIDE) -> PreparedImage:
    if len(data) == 0:
        raise ImageValidationError("empty upload")
    if len(data) > MAX_BYTES:
        raise ImageValidationError(f"file exceeds {MAX_BYTES // (1024 * 1024)} MB", status=413, code="too_large")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format or ""
            probe.verify()
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ImageValidationError(f"not a readable image: {exc}", code="unsupported_type") from exc
    except Image.DecompressionBombError as exc:
        raise ImageValidationError("image has too many pixels", status=413, code="too_large") from exc
    if fmt not in ALLOWED_FORMATS:
        raise ImageValidationError(f"unsupported format {fmt!r}; use JPEG, PNG or WebP", code="unsupported_type")

    with Image.open(io.BytesIO(data)) as img:
        if img.width * img.height > MAX_PIXELS:
            raise ImageValidationError("image exceeds 40 megapixels", status=413, code="too_large")
        img = ImageOps.exif_transpose(img)  # bake orientation, then drop metadata
        img = img.convert("RGB")  # new image object: no EXIF / GPS / ICC carried over
        ow, oh = img.size
        scale = min(1.0, max_side / max(ow, oh))
        if scale < 1.0:
            img = img.resize((round(ow * scale), round(oh * scale)), Image.LANCZOS)
        rgb = np.asarray(img, dtype=np.uint8).copy()
    return PreparedImage(rgb=rgb, original_width=ow, original_height=oh, scale=scale, format=fmt)


def load_rgb(path: str) -> np.ndarray:
    with Image.open(path) as img:
        return np.asarray(ImageOps.exif_transpose(img).convert("RGB"), dtype=np.uint8).copy()


def rescale_analysis(analysis: dict[str, Any], factor: float, width: int, height: int) -> dict[str, Any]:
    """Map image-space geometry by `factor` (e.g. inference px -> original px)."""
    if abs(factor - 1.0) < 1e-9:
        return analysis
    f = factor
    for d in analysis["detections"]:
        d["bbox"] = [round(v * f, 1) for v in d["bbox"]]
        if d.get("polygon"):
            d["polygon"] = [[round(x * f, 1), round(y * f, 1)] for x, y in d["polygon"]]
    for key in ("roofline", "groundline"):
        analysis[key] = [{"x": p["x"] * f, "y": p["y"] * f} for p in analysis.get(key) or []]
    for r in analysis.get("floorRows") or []:
        for k in ("yCenter", "yMin", "yMax", "intercept", "medianWindowHeight"):
            if k in r:
                r[k] = round(r[k] * f, 2)
    for c in analysis.get("windowColumns") or []:
        c["xCenter"] = round(c["xCenter"] * f, 2)
    analysis["imageWidth"] = width
    analysis["imageHeight"] = height
    analysis.setdefault("warnings", [])
    return analysis
