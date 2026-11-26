#!/usr/bin/env python3
"""Build analysis.json + depth artefacts for a curated example.

Usage (from repo root):
    cd api && uv run python ../scripts/analyze_example.py <example-id> [--no-depth]

Inputs
    web/public/examples/<id>/photo.jpg       the published photo
    data/raw/<id>/roboflow_raw.json          UNMODIFIED Roboflow response (replayed)
    data/raw/<id>/roboflow_meta.json         optional: {provider, modelId, inferredAt, inputWidth, inputHeight, note}
If roboflow_raw.json is missing and ROBOFLOW_API_KEY is set, hosted inference
is run once and the raw response + meta are saved for reproducibility.

Outputs (web/public/examples/<id>/)
    analysis.json   FacadeAnalysis (web/src/schema/scene.ts)
    depth.png       16-bit grayscale relative depth (max 640 px side)
    depth16.bin     same values, raw uint16 little-endian row-major
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from sunvision_cv.analysis import build_analysis  # noqa: E402
from sunvision_cv.depth import default_depth_provider  # noqa: E402
from sunvision_cv.images import load_rgb, rescale_analysis  # noqa: E402
from sunvision_cv.providers import (  # noqa: E402
    ProviderResult,
    ReplayProvider,
    RoboflowHostedProvider,
    api_key_from_env,
)

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except ImportError:
    pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("example_id")
    ap.add_argument("--no-depth", action="store_true")
    ap.add_argument("--confidence", type=float, default=0.3)
    args = ap.parse_args()

    ex_dir = ROOT / "web" / "public" / "examples" / args.example_id
    raw_dir = ROOT / "data" / "raw" / args.example_id
    photo = ex_dir / "photo.jpg"
    if not photo.exists():
        print(f"missing {photo}", file=sys.stderr)
        return 2
    raw_path = raw_dir / "roboflow_raw.json"
    meta_path = raw_dir / "roboflow_meta.json"
    rgb = load_rgb(str(photo))
    ph, pw = rgb.shape[:2]

    if raw_path.exists():
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        result = ReplayProvider(raw_path, provider_label=meta.get("provider", "roboflow-hosted"), model_id=meta.get("modelId")).infer()
        inferred_at = meta.get("inferredAt")
        if meta.get("inferenceMs") is not None:
            # Wall-clock latency measured when the call was recorded (the raw "time" field is server-side only).
            result.inference_ms = float(meta["inferenceMs"])
        print(f"replaying recorded inference {raw_path.relative_to(ROOT)}")
    elif api_key_from_env():
        raw_dir.mkdir(parents=True, exist_ok=True)
        prov = RoboflowHostedProvider(confidence=args.confidence)
        result: ProviderResult = prov.infer(rgb)
        inferred_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        raw_path.write_text(json.dumps(result.raw))
        meta_path.write_text(json.dumps({
            "provider": result.provider, "modelId": result.model_id, "inferredAt": inferred_at,
            "inputWidth": pw, "inputHeight": ph, "confidence": args.confidence,
            "inferenceMs": round(result.inference_ms, 1), "service": result.service,
        }, indent=2))
        print(f"ran hosted inference in {result.inference_ms:.0f} ms; saved raw response")
    else:
        print("no recorded inference and ROBOFLOW_API_KEY not set", file=sys.stderr)
        return 3

    raw_w, raw_h = int(result.raw["image"]["width"]), int(result.raw["image"]["height"])
    # Depth runs on an image matching the inference resolution so per-detection sampling lines up.
    if (raw_w, raw_h) != (pw, ph):
        import cv2

        rgb_inf = cv2.resize(rgb, (raw_w, raw_h), interpolation=cv2.INTER_AREA)
    else:
        rgb_inf = rgb
    depth_provider = None if args.no_depth else default_depth_provider()
    analysis, enc = build_analysis(
        result,
        image_rgb=rgb_inf,
        depth_provider=depth_provider,
        depth_url="depth.png",
        depth_bin_url="depth16.bin",
        confidence_threshold=args.confidence,
        inferred_at=inferred_at,
    )
    if (raw_w, raw_h) != (pw, ph):
        if abs(pw / raw_w - ph / raw_h) > 0.01:
            print(f"aspect mismatch photo {pw}x{ph} vs inference {raw_w}x{raw_h}", file=sys.stderr)
            return 4
        analysis = rescale_analysis(analysis, pw / raw_w, pw, ph)
        analysis["warnings"].append(f"inference ran at {raw_w}x{raw_h}; geometry rescaled to photo {pw}x{ph}")
    if enc:
        (ex_dir / "depth.png").write_bytes(enc["png"])
        (ex_dir / "depth16.bin").write_bytes(enc["bin"])
    (ex_dir / "analysis.json").write_text(json.dumps(analysis, indent=1))
    counts = analysis.get("classCounts", {})
    print(f"wrote {ex_dir.relative_to(ROOT)}/analysis.json: {counts}, rows={len(analysis['floorRows'])}, "
          f"depth={'yes' if enc else 'no'}, warnings={analysis['warnings']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
