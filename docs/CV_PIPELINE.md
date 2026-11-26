# Computer vision pipeline

sunvision-ai turns one street photograph into **structured, image-space architectural
observations**. Metric reconstruction (heights in metres, window positions on the 3D facade)
happens afterwards in the browser (`web/src/lib/reconstruct.ts`), so that manual corrections
to the camera or detections take effect immediately.

```
photo ──► EXIF strip / orient / ≤2048 px ──► RF-DETR-Seg facade model (Roboflow) ──► raw JSON (stored as-is)
                                                     │
                                                     ▼
                       Supervision: from_inference → CompactMask → class thresholds → mask NMS
                                                     │                     → tiny-window filter → mask_to_polygons
                                                     ▼
   primary facade ─► roofline / groundline        window rows (Theil–Sen)       window columns
                                                     │
   Depth Anything V2 Small (local) ─► relative inverse depth ─► per-detection median depth
                                                     ▼
                              FacadeAnalysis JSON  (+ depth.png / depth16.bin)
```

Code: `api/sunvision_cv/` — `providers.py`, `processing.py`, `facade.py`, `depth.py`,
`analysis.py`, `images.py`, `app.py`. Fixtures: `scripts/analyze_example.py`.

## 1. Detection & segmentation — Roboflow RF-DETR

* Model: [`building-facade-segmentation-instance/4`](https://universe.roboflow.com/building-facade/building-facade-segmentation-instance)
  on Roboflow Universe — an **RF-DETR Instance Segmentation 2X-Large** checkpoint trained at
  768×768 on 598 facade images. Classes: `facade, window, balcony-fence, vegetation, shop,
  street, car, fence, non-building-infrastructure, traffic-infrastructure`. Reported metrics on
  the Universe page (v4): mAP 0.648, precision 0.737, recall 0.615. Dataset/model license
  **CC BY 4.0** (attribution: Roboflow Universe workspace "Building Facade").
* We did **not** train anything. Generic COCO RF-DETR weights have no window/facade classes and
  are not used.
* The model has no `door` or `roof` class. Doors are not detected; rooflines are derived from
  the facade mask (§3).

Providers (`providers.py`), all returning the unmodified Roboflow response:

| provider | how | image leaves machine? | needs |
|---|---|---|---|
| `RoboflowHostedProvider` | `inference_sdk.InferenceHTTPClient(api_url="https://serverless.roboflow.com")` `.infer()` | **yes** (Roboflow Serverless) | `ROBOFLOW_API_KEY` |
| `RoboflowLocalProvider` | `inference.get_model(model_id, api_key)` (Roboflow Inference) | no (weights downloaded once) | `uv sync --extra local`, key once |
| `ReplayProvider` | reads `data/raw/<id>/roboflow_raw.json` | no | — |

Curated examples always use `ReplayProvider`: the public demo never runs live inference, and
the raw responses are kept byte-for-byte so the processing is reproducible.

## 2. Post-processing — Roboflow Supervision

`processing.py` uses `supervision` (0.30):

* `sv.Detections.from_inference(raw, compact_masks=True)` — polygons → `CompactMask`
  (crop-RLE), avoiding N full-resolution boolean masks for photos with 100+ windows.
  Prediction order is preserved, so the Roboflow `detection_id`s are attached as
  `data["detection_id"]` and survive every filter.
* Per-class confidence thresholds (windows 0.35, facades 0.40, …).
* Windows: `with_nms(0.5, class_agnostic=True)` (mask IoU) followed by
  `with_nms(0.85, overlap_metric=sv.OverlapMetric.IOS)` to drop windows nested inside a
  higher-scoring one; then an area filter (≥ 0.003 % of the image and ≥ 8 % of the median
  window area) removes specks.
* `sv.mask_to_polygons` on each mask crop + `cv2.approxPolyDP` (ε = 0.4 % of perimeter)
  gives compact polygons for the browser (Supervision.js renders them).

Note: for large regions (facades) the model's predicted box and its mask can disagree by a few
pixels to tens of pixels; we keep both as returned (box = model box, polygon = mask outline).

## 3. Facade features (`facade.py`, image space)

* **Primary facade** = argmax of `area × centrality × (1 + 0.05·windows inside) × score`.
* **Roofline / groundline**: for ~40 columns across the primary facade mask, the top-most and
  bottom-most mask pixel, smoothed with a 5-tap median filter (removes chimneys, signs).
  If more than 30 % of the columns touch the image's top border we warn that the roof is
  cropped (height becomes a lower bound); same for the bottom border.
* **Floor rows** (`cluster_rows`):
  1. dominant slope = median slope over window pairs at similar height (handles roll and
     horizontal perspective);
  2. 1-D gap clustering of slope-corrected centre-y, gap > 0.55 × median window height;
  3. two rounds of per-row Theil–Sen line fits (≥3 windows, otherwise the global slope),
     re-assignment of each window to its nearest row line, and merging of rows whose lines
     are < 0.4 × median window height apart.
  Output rows are ordered bottom (index 0) to top with `yCenter` (at the median window x),
  `yMin/yMax`, `slope`, `intercept` and member `windowIds`. Rows are *observed rows of
  windows*, not floors: the browser decides how they map to floors (ground floor without
  windows, shopfronts, attic rows).
* **Columns**: gap clustering of window centre-x (informational).

## 4. Depth — Depth Anything

* Fixtures use **Depth Anything V2 Small** (`depth-anything/Depth-Anything-V2-Small-hf`,
  Apache-2.0) through Hugging Face `transformers`, locally on CPU/Apple MPS.
* Roboflow `inference-models` also serves `depth-anything-v3/small|base` and
  `depth-anything-v2/*` via `AutoModel.from_pretrained(...)`. The official docs state these
  pretrained ids **require a Roboflow API key**. The fixtures use the `transformers` path, and
  `InferenceModelsDepth` is an optional provider
  (`SUNVISION_DEPTH_PROVIDER=inference-models`, requires `pip install inference-models` and
  `ROBOFLOW_API_KEY`). The fixtures and tests do not exercise it end-to-end.
* Output is **relative inverse depth** (disparity-like; larger = nearer). It is never treated
  as metres. It is downscaled to ≤ 640 px, quantised to 16 bits (`rawMin/rawMax` recorded),
  and written as `depth.png` (viewing) and `depth16.bin` (uint16 LE row-major, what the
  browser samples, because canvas cannot read 16-bit PNGs exactly). The API returns the
  same as a data URL + `binBase64`.
* Per detection we store `depthMedian` (median inside its polygon). The browser calibrates
  relative depth against map distances (camera → footprint) and only uses depth where the
  result is geometrically consistent. Uncalibrated, the browser also uses its depth
  *discontinuities*: roofline samples and windows at least 2× farther than the facade plane
  they project onto (a building behind it, swallowed by the facade mask) are set aside
  ([RECONSTRUCTION.md](RECONSTRUCTION.md#buildings-behind-the-facade-depth-discontinuities)).

## 5. Model confidence vs. geometric uncertainty

These are reported separately and must not be conflated:

* `Detection.confidence` is the RF-DETR score: how sure the model is that the pixels belong
  to the class. It says nothing about metric accuracy.
* Geometric uncertainty (height bounds, floor-height spread, calibration sensitivity) is
  computed in the browser from camera/footprint geometry and appears as `Estimate.low/high`.
  These bounds are plausibility ranges, not calibrated confidence intervals.
* Manual edits get `source: "manual"`, confidence 1, and are labelled as such in the UI.

## 6. API

`cd api && uv run uvicorn sunvision_cv.app:app --reload --port 8000`

* `GET /api/health` — providers available, whether a key is configured, depth availability.
* `POST /api/analyze` (multipart `file`, `?provider=hosted|local&depth=true&confidence=0.3`)
  — JPEG/PNG/WebP only (verified by decoding, not by extension), ≤ 15 MB, ≤ 40 MP.
  EXIF orientation is applied, then **all metadata (incl. GPS) is dropped** before
  inference; images are downscaled to ≤ 2048 px for inference and geometry is mapped back to
  original pixel coordinates. Nothing is stored on disk; image bytes are never logged. The
  response includes `privacy.sentToExternalService` / `privacy.service`.
* Errors: `400 unsupported_type`, `413 too_large`, `503 missing_api_key` /
  `provider_not_installed`, `502` for upstream failures.

## 7. Limitations

* One model, trained on 598 images: recall ~0.6 means windows will be missed (especially
  small, dark, reflective or heavily oblique ones). The UI lets users add/delete windows.
* No door or roof classes; roof structures (dormers, mansards) are only visible as facade-mask
  shape changes.
* Row clustering assumes roughly horizontal floor lines in a locally planar facade; extreme
  wide-angle distortion or curved facades will split/merge rows. Users can reassign floors.
* Monocular depth is relative and can be inconsistent across depth discontinuities; it is a
  weak cue and is weighted accordingly.
