# Reconstruction: from detections to editable geometry

Code: [`web/src/lib/reconstruct.ts`](../web/src/lib/reconstruct.ts), [`align.ts`](../web/src/lib/align.ts), [`camera.ts`](../web/src/lib/camera.ts), [`views.ts`](../web/src/lib/views.ts), [`obstacles.ts`](../web/src/lib/obstacles.ts), [`apartmentOps.ts`](../web/src/lib/apartmentOps.ts), [`vegetation.ts`](../web/src/lib/vegetation.ts). Tests: [`__tests__/reconstruct.test.ts`](../web/src/lib/__tests__/reconstruct.test.ts) and [`align.test.ts`](../web/src/lib/__tests__/align.test.ts) (synthetic ground truth), and [`examples.test.ts`](../web/src/lib/__tests__/examples.test.ts) (real fixtures against references). The alignment method and its measurements are documented in [`research/alignment.md`](research/alignment.md).

Reconstruction runs in the browser so that every manual correction (camera, window box, floor count, height) re-runs the whole chain instantly: detections → rays → heights → geometry → sunlight.

## Photos: one primary, any number of surroundings

A scene has one primary photograph (`scene.image`, `camera`, `analysis`) and optional **extra views** of the surroundings (`scene.extraViews`, each a `PhotoView` with its own image, camera, analysis, depth map, target building and facade edge). `sceneViews()` in `lib/views.ts` presents them all as `ViewInput`s with the user's current camera and detections. Everything below runs per view; heights are then fused per building across views.

## Camera model

A pinhole camera in the local ENU frame (x east, y north, z up, metres). It has a heading (compass degrees of the optical axis), pitch (+ up), roll, horizontal FOV and lens height above the ground; the principal point is the image centre. `pixelToRay` and `worldToPixel` are exact inverses (tested to 1e-6 px).

Initial values and their provenance:

| Parameter | Source |
|---|---|
| position | EXIF GPS / Commons `{{Location}}` (*observed*), map pin (*manual*), automatic placement across the nearest street for uploads (`autoCameraForBuilding`), or re-placed when the geotag marks the subject (*inferred*) |
| heading | EXIF `GPSImgDirection` / geotag heading (*observed*), the map aim, or facing the facade midpoint from the automatic position |
| hfov | `2·atan(h / f35)` from the EXIF 35 mm-equivalent focal length (*observed/inferred*), where h is half of the 43.27 mm diagonal's share along the image width (this equals `2·atan(36 / 2·f35)` for 3:2 landscape; the manual camera-placement wizard and the add-view dialog use the 3:2 formula), else 60° (*assumed*, then inferred from storeys, below) |
| pitch | **solved** (below), else assumed |
| height | 1.6 m (*assumed*, hand-held) |

## Camera calibration on load

`calibrateViewCamera()` runs for every view when a scene loads:

1. **Pitch from the ground line**, when the pitch is only *assumed*.
2. **FOV from storey spacing**, when the FOV is only *assumed* (no focal length).
3. **Auto-alignment from facade regularity**, for every parameter that is not *manual*.

The aligned camera becomes the view's reference camera, so *Reset camera* returns to it. Each step adds a note to `camera.notes`, which the Camera tab shows.

### 1 · Pitch auto-calibration from the ground line

The facade mask gives a *ground line*: the lowest facade pixel per column. RF-DETR labels street-level shopfronts as `shop`, separate from `facade`, so each ground-line sample is extended down through any shop or door detection directly beneath it (`effectiveGroundline`). `plausibleGroundline` then drops samples that have a window ending below them within 1.5 window widths: those sit on an awning, canopy or sign, not on the pavement. Each remaining sample's ray is intersected with the camera-facing facade planes, and pitch is solved by bisection so that the median hit height is 0 m. The residual is shown in the Camera tab as a health indicator.

On the fixtures this matters: Paris starts from an assumed 22°. The loaded camera (pitch solve, then auto-align) has 9.91°, which takes the height from 35.35 m to 24.12 m against a reference of 24.5 m ([VALIDATION.md](VALIDATION.md)). Paris's ground line still lies partly on café awnings, so its pitch is probably biased low.

### 2 · FOV from storey spacing (`inferHfovFromStoreys`)

With no focal length, the FOV is a guess, and every metric height on the facade scales with tan(hfov/2), because the camera position comes from the map. Regularity cannot see that scale. So, only when the FOV is *assumed*, sunvision-ai picks the FOV at which the target's window rows are `TYPICAL_STOREY_M` = **3.3 m** apart. It needs at least 4 windows on the target and two rows, and it alternates with the pitch solve until both settle. The FOV becomes *inferred*, gets a ±15 % `hfovRange`, and its note says the heights inherit this assumption (about ±15 %). A camera whose FOV is observed or inferred (for example from an EXIF focal length) never goes through this step; a photo whose crop makes the focal length unusable can still be marked assumed (e.g. the NYC PS 140 view).

### 3 · Auto-alignment from facade regularity (`autoAlignCamera`)

The cost combines robust (truncated Cauchy) terms:

* **ground:** z of the plausible ground-line samples on the facade planes;
* **rows:** z of windows in the same image row and building, against the row median, relative to the median window height;
* **columns:** u along the facade of windows in the same image column and plane, relative to the median window width;
* **rectangles and sizes:** how far each window outline is from a rectangle after rectification onto its plane, and the spread of window sizes in a row or column;
* **coverage:** the fraction of windows that miss every facade plane.

The row, column, rectangle and size terms are scale-free, so the optimiser cannot cheat by moving towards the facade. Rows and columns come from `windowGrid`, an image-space nearest-neighbour chaining that follows slanted rows and converging columns and does not depend on the camera. On NYC it finds 8 rows where the Python 1-D row clustering finds 2.

* **Free parameters:** pitch, roll, hfov, a heading offset, and position along the target facade's normal and along the facade. A parameter is free only if its provenance is not *manual*.
* **Priors by provenance** (weight 0.05 per σ²):

  | Parameter | observed | inferred / map | assumed |
  |---|---|---|---|
  | pitch | 1.5° | 4° | 12° |
  | roll | 1° | 2° | 4° |
  | hfov | 2° | 5° | 20° |
  | heading | 4° | 6° | 15° |
  | position | 4 m | 6 m | 12 m |

  A scale prior holds log(distance × tan(hfov/2)) near its input value (σ 5 %, 10 % or 30 %), because a near-frontal photo hardly separates FOV from distance.
* **FOV bounds** (`hfovRangeFor`): the camera's own `hfovRange` if it has one; else [0.5, 1.05] × hfov when the FOV comes from EXIF, since a crop narrows the FOV and nothing widens it; else the aligner's wide default (20–110°).
* **Optimiser:** deterministic bounded Nelder–Mead with restarts, no dependencies.
* **Acceptance:** a camera is kept only if the cost improves by at least 5 % **and** the metric misalignment (within-row z spread + within-column u spread) drops by at least 5 cm **and** by at least 20 %. Otherwise the camera is unchanged. This stops it from "improving" photos whose windows already line up: Amsterdam is refused.
* **Output:** changed parameters become *inferred*, and a note "Auto-aligned from facade regularity: …" is added.

The Camera tab has *Auto-align from windows* to re-run it on the current camera (undoable).

### Corner resection (*Check the fit*)

When regularity is not enough, *Check the fit* draws the projected footprints of the visible buildings on the photo, with a draggable dot on every corner. Dropping a dot on the matching corner creates a correspondence: a *street-level corner* (where the corner meets the pavement) or a point *anywhere on the edge* (its height left free, so only its horizontal position counts). `solveFromCorrespondences` (a port of `scripts/solve_camera.py`, bounded Levenberg–Marquardt with restarts across the FOV range) solves as much as the points allow:

| Equations (2 per street-level corner, 1 per edge point) | Solved |
|---|---|
| 6 or more | full pose |
| 4–5 | orientation and FOV; position fixed |
| 2–3 | heading and pitch only |

Solved parameters become *manual*, and the points and their rms are stored in `camera.alignment`. The fit chip is grey while the fit is exact (no redundant equations), because an exact fit cannot reveal a bad pick. *Auto-fit* runs `autoAlignCamera` jointly with the picks, as a reprojection term (σ 15 px) under a robust loss, so one bad pick cannot dominate. **No building height enters either solver.**

The curated NYC camera shows why picks need checking: its hand-picked resection from six maintainer picks has one wrong corner. The fixture uses the regularity-aligned camera (*inferred*), and the picks are stored for reference ([`data/calibration/nyc-ridge-street.json`](../data/calibration/nyc-ridge-street.json), status *superseded*).

## Facade planes

For each photo's target and visible buildings, every footprint edge that faces the camera becomes a vertical plane, with an outward normal from the CCW ring. Each pixel ray is tested against all of them, and the nearest hit wins (`hitFacades`). This handles corner buildings, stepped fronts (Amsterdam's stoop edge) and a photo spanning two OSM buildings (Paris).

## Height methods

### A · floors × floor height

1. Project every window detection's box centre and edges through the camera onto its facade plane, giving the metric centre height *z*, width and height.
2. Cluster the windows per building into rows by metric *z* (gap ≥ max(0.9 m, 0.75 × median window height)). Rows are found in metric space, so perspective doesn't skew them.
3. **Measured floor-to-floor height** = median gap between consecutive rows. It is accepted if it falls between 2.4 and 5.5 m. Otherwise the assumed default (3.0 m) is used, and the photo's camera scale is flagged as suspect (below).
4. Floors below the lowest row (shops, doors, occlusion) = `round((z_lowest − 0.55·fh − groundExtra)/fh)`.
5. `H_A = floors × fh + groundExtra + 0.6 m` (parapet/cornice allowance). The upper bound allows one unseen top floor.

### B · camera ray ∩ facade plane

Every roofline sample's ray is intersected with the facade planes. For a vertical facade on level ground this reduces to the textbook `h = h_cam + d·tan(θ)` (verified in the tests). The estimate is the upper quartile of the hits per building, which is robust to dips in the mask. Bounds come from re-running with pitch ±1° and from the roofline spread. Samples at the image border (a roof cut off by the frame) are ignored, and so are samples the depth map puts on a building behind the facade (see *Buildings behind the facade* below).

### C · calibrated relative depth

Depth Anything outputs affine-invariant *relative inverse depth*, not metres. sunvision-ai samples a grid of **street** pixels (inside the `street` detection), where the metric distance *Z* is known from the ground-plane intersection and the pixel is not occluded by a facade. It fits `d = α/Z + β` by least squares, requiring α > 0 and at least 12 samples. Each roofline point is then located along its ray at the calibrated distance. Monocular depth is the least constrained method, so its prior weight is halved, and it is excluded when inconsistent. Each extra view uses its own depth map.

### Buildings behind the facade (depth discontinuities)

The facade mask can swallow a taller building far behind the one photographed: its outline then becomes part of the "roofline", and windows on it project onto the front facade (in the Vilsonovo photo of Sarajevo, the regression fixture `web/src/lib/__tests__/fixtures/vilsonovo/`, the Parliament tower 230 m from the camera adds about 4 m and a false storey without this check). Height methods would read it as part of the facade. When the photo has a depth map, `depthBackground` (in `reconstruct.ts`) sets such points aside before any method runs. It needs no calibration of the depth map, so it also works where method C cannot be calibrated (the Vilsonovo fixture, New York).

* **What is compared.** Depth Anything gives relative *inverse* depth, `d ≈ s/Z` with *Z* the depth along the optical axis and the sky at ≈ 0. For a point that really lies on a facade plane, *d* times the metric axial depth *Zₚ* of its ray–plane hit is the same constant *s* everywhere in the frame, near or far, left or right. The reference is the median `d·Zₚ` of the windows on the same building (at least 3; otherwise of all windows in the photo, at least 3; otherwise nothing is checked). For something farther away, the ratio `d·Zₚ / reference ≈ Zₚ/Z` drops below 1.
* **Where depth is read.** A window: the median of a 3 × 3 grid over the central half of its box. A roofline sample: the median of a 5 × 5 patch just below it (0.5–2 % of the image height down, ±0.4 % of its width), so the facade under the roof edge is read and not the sky above it. Medians make single-pixel noise and mask edges harmless.
* **Rule.** A ratio under **0.5**, i.e. at least **2× farther** than the facade plane, is "behind". Measured on Amsterdam, Paris, New York, the Vilsonovo fixture and their extra views: windows on their own facade read 0.83–1.20, genuine roofline samples 0.73–1.2 (a pitched roof recedes behind the facade plane, edge samples mix in sky), single mixed samples down to 0.61. What lies behind reads far lower: the Vilsonovo tower 0.27–0.33 with one sample at 0.18 (the false window on it 0.30), the Gare de Lyon tower behind *Le Mistral* 0.28–0.47 (six windows on it 0.36), three windows of a building seen behind the NYC school 0.39–0.45. A 1.5× threshold (0.65) would also catch stretches that are part roof, part something behind (Vilsonovo's right-hand ridge at 0.54–0.61, chimneys behind an Amsterdam gable at 0.51–0.57), which is not clear-cut. On the Sarajevo example (Obala Kulina bana 24) nothing is set aside. If the depth map has a positive affine shift, far objects read closer to 1 and fewer are set aside, which is the safe side.
* **Guards.** A ratio under 0.1 (≥ 10× farther) reads as sky, not as a building: under a roofline sample that is usually a thin roof element (spire, chimney, antenna) the 640-px depth map does not resolve, so it is left alone. A background object hides a stretch of the roofline, so a roofline sample is set aside only together with an adjacent one; an isolated far sample is noise. A building must keep at least 3 roofline samples and at least a quarter of them in that photo, otherwise its whole roofline is used.
* **Effect.** Roofline samples set aside are not used by B or C, nor as the roofline that hides windows above it (`rooflineHits[].behind` marks them). Windows set aside are not placed, form no row and no floor, and do not raise the height (window floor). They are dropped, not re-assigned to the building behind: that building is usually not one of the photographed footprints. One warning per photo says what was set aside and how much farther it is, e.g. *"10 roofline samples and 1 window set aside: the depth map puts them about 3× farther than the facade they project onto (something behind it, such as a taller building further away)."* Provenance labels are unchanged. Without a depth map nothing changes.

### Camera-scale check

If a photo's window rows on a building measure an implausible storey spacing (outside 2.4–5.5 m), that photo's camera scale is probably wrong. Its B and C for that building are set aside, with a warning that says so (and says when the FOV is only assumed). For an extra view, A is set aside too, and its windows on that building are not placed. The main photo's windows on such a building are not placed either, unless it is the target: their rays most likely passed the end of the footprint they belong to and hit a building far behind (in the Vilsonovo fixture, three windows on the block's rounded corner would otherwise form rows 6 m apart on the Parliament building 150 m from the camera). Because the camera is then not the likely culprit, the warning for such a building says the rays probably passed the end of a footprint and does not advise recalibrating the camera. The target always keeps its windows. Windows of an extra view that lie more than 1 m above the roofline the same photo measured are also not placed.

### D · fusion

* Each method of each photo has a plausible range [low, high], with σ = (high − low)/2 (minimum 0.5 m). Method names of extra views carry the view's label.
* Weight = prior / σ²: prior 1 for A and B, 0.5 for C.
* With three or more methods, any method more than max(6 m, 35 %) from the median is excluded and labelled as such. Implausible values (<2 m or >400 m) are excluded too.
* A building seen **only** in extra views that is left with at most one used photo method keeps its explicit OSM `height` tag as an anchor method (`Map · osm:height`), and as the reference for excluding outliers, because those cameras are only roughly placed. Two or more agreeing photo methods override the tag, and a building with only `building:levels` gets no anchor.
* **Best estimate** = weighted mean. **Plausible range** = weighted mean of the bounds, widened to cover the spread between methods.
* **Window floor:** a building is never lower than the top of its highest placed window + 0.3 m (`minHeightFromWindows`). When the estimate is raised, a warning names the building, the lower bound moves up and the upper bound is kept. A *manual* height is never raised; you get a warning instead. Windows measured through a suspect camera scale do not count.
* The UI shows each method's value, range, weight and explanation, and states plainly when only one method was available.

These ranges are **heuristic, not statistically calibrated confidence intervals**. [VALIDATION.md](VALIDATION.md) reports the real errors.

### Map priors and modes

| Mode | Photographed buildings | Other buildings |
|---|---|---|
| **Vision-first** (default) | photos only (plus the explicit OSM `height` tag as an anchor for buildings seen only in extra views and left with at most one photo method; `building:levels` alone gives no anchor) | OSM `height` → `building:levels × fh + 1` → scene median of photo heights (*assumed*, ±40 %) |
| **Map prior** | photo methods + the OSM tag as an extra method | same |
| **Map only** | OSM / assumptions (baseline for comparison) | same |

For uploads, footprints come from OpenFreeMap vector tiles, which carry a rounded `render_height` but no levels ([`research/tiles.md`](research/tiles.md)). Buildings that are not visible in any photo are **never** labelled as reconstructed from one.

## Geometry

* **Buildings:** footprints extruded from `min_height` to the estimated height. The target always uses its best estimate. The *low / best / high* scenario switches every **other** building to its bound, and trees to ±25 %.
* **Windows:** placed on their facade plane at the measured *u* (along the edge), *z*, width and height, then **regularised** (`regularizeFacadeWindows`, on by default):
  * storeys are levelled per building across all its facades (floors are level around a corner), using the image rows from `windowGrid`, with metric clustering as a fallback;
  * columns are aligned per facade, and widths and heights snap to the row or column median;
  * a coordinate snaps only if it moves 0.6 m or less, and a window centre never moves more than 0.6 m in total;
  * windows centred off their facade are dropped, duplicates are merged, and *manual* windows never move.

  Method A uses the raw hits, so the snapping does not change the height estimate. Floor = `floor((z − groundExtra)/fh)`. Provenance: *observed*, or *manual* for user-drawn boxes. Windows from every view are placed.
* **Balconies:** each `balcony-fence` detection becomes a slab under its railing, as wide as the railing measured on the plane. Its depth is *assumed* at 1.0 m, because protrusion isn't observable frontally.
* **Trees:** OSM `natural=tree`, with the `height` tag or an *assumed* 10 m and a 3 m crown. Large vegetation detections that reach the street are also placed: the bottom ray is intersected with the ground, height and crown come from the top ray and the mask width at that distance. They are kept only where OSM has no tree within 4 m, and are labelled *inferred*.
* **Apartment:** spans the selected windows' *u* range plus a side margin. Its floor sits at `max(0, lowest sill of the selected windows − sill height)`, where the sill height is an editable assumption (default 0.9 m); the ceiling is raised if needed so that it never cuts through a window. It has a user-set depth, ceiling, internal walls (illustrative) and an optional overhang slab. It is always labelled *hypothetical interior*. The simple-mode room controls (`apartmentOps.ts`) only change which windows are selected and the margin and depth:
  * *Wider* adds the nearest column of windows on the same floor and facade within 2.5 m, or else widens the margin by 0.5 m (up to 4 m);
  * *Narrower* does the reverse;
  * *Floor ↑/↓* moves each selected window to the nearest window (within 2.5 m along the facade) one floor up or down;
  * *Deeper*/*Shallower* change the depth in 1 m steps.

Everything is plain data (`ObstacleScene`, `WindowSpec`), shared verbatim by the Three.js view and the solar engine.
