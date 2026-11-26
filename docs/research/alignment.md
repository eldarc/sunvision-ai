# Window skew and camera alignment from facade regularity

**Problem.** A camera that is a few degrees off skews the 3D window grid. In the NYC example (`nyc-ridge-street`) the photo shows a corner tenement with a perfectly regular window grid. Under the maintainer resection camera, the same windows sit at different heights and sizes in 3D, and some float above the roof.

**Code:** [`web/src/lib/align.ts`](../../web/src/lib/align.ts)
**Tests and report:** [`web/src/lib/__tests__/align.test.ts`](../../web/src/lib/__tests__/align.test.ts)
**How to reproduce the numbers:** `cd web && ./node_modules/.bin/vitest run src/lib/__tests__/align.test.ts --silent=false`. The test prints a `console.table` of the figures below and a JSON line of diagnostics per fixture.

All numbers come from the recorded fixtures in `web/public/examples/*`. None are tuned to the references. The **baseline camera** is the camera before auto-alignment: the fixture camera, with pitch solved by `calibratePitch()` when it is only *assumed*. For NYC the baseline is the maintainer resection from the picks in `data/calibration/nyc-ridge-street.json` (heading 48.57°, pitch 17.07°, roll 1.34°, hfov 41.9°, all *manual*). The shipped NYC fixture carries the aligned camera instead (§4.4), and records the resection in its `camera.notes`. Because the test runs on the shipped fixtures, its NYC rows start from the aligned camera; the NYC baseline figures below refer to the resection.

## TL;DR

1. **NYC: almost all of the skew is camera error, not detection noise.**
   * The resection camera is marked *manual* and has an rms error of 33 px. Its heading is about 10° off and its roll about 2° off.
   * Under that camera, the windows of one storey on the Ridge Street facade fall from z = 22.9 m to 18.4 m going left to right. Across the building, the within-row z spread is 0.80 m (robust σ).
   * Box noise accounts for only 0.14 m of that. In variance terms, about 98 % of the scatter is camera error.
   * The wrong camera also sends 14 windows onto `way/278279522`, a building across Rivington Street next to the photographer. They land at z ≈ 9 m, while their row-mates on the target are at ≈ 17 m.
   * The building comes out with 8 "storeys" at 4.2 m each and a height of 28.9 m. The reference is 21.4 m. Six windows float above the roof.
2. **Self-calibration from facade regularity fixes NYC.**
   * `autoAlignCamera`, with the provenance relaxed from *manual* to *inferred* and FOV bounded by the EXIF range [41.9°, 61.6°], gives:
     * within-row spread 0.80 m → **0.11 m**, all windows on the right buildings, 0 floating windows;
     * 6 storeys at 3.16 m;
     * height **21.3 m** (reference 21.4 m).
   * Projected at the OSM height, the footprint outline then lands on the real parapet, the corner and the boundary with 202 Rivington.
   * The maintainer pick for footprint vertex 1 is inconsistent with this camera by 433 px. It marks the end of the ornate bays, not the end of the 28 m OSM edge (the rear section continues behind the tree).
3. **Regularisation is needed but is not enough by itself.**
   * `regularizeFacadeWindows` snaps rows, columns and sizes.
   * Under the NYC resection camera it can level only part of the grid: 68 → 37 windows remain more than 10 cm off their row, because the 4.5 m drift is beyond the 0.6 m safety cap.
   * Under the aligned camera it levels all of them (35 → 0).
4. **The other two fixtures:**
   * **Amsterdam** is already regular (7 cm). Auto-align correctly refuses to change it.
   * **Paris** improves (48 → 33 cm; height 21.8 → 23.6 m against a reference of 24.5 m).
   * However, Paris exposes a second problem: its detected "ground line" lies on the café awnings.

## 1. Diagnosis (baseline camera)

`diagnoseWindows(view, camera, detections, heights)` measures the following:

* **Rows** are image rows of windows, found by chaining nearest neighbours (`windowGrid`, camera independent). They are split by building.
* **Columns** are image columns, split by facade plane.
* **Spread** is 1.4826·MAD of the deviation from the group median: robust σ, in metres.
* **Box noise** is the robust residual of window centres about a straight line fitted through each image-row segment. Any pinhole camera maps a world row to a straight image line, so this is the camera-free noise floor of the detector. It is converted to metres at each window's distance.
* **Skew** is how far each segmentation outline is from a rectangle after rectification onto its plane: Δu/height of the side edges and Δz/width of the top and bottom edges.

| | Amsterdam | Paris | New York |
|---|---|---|---|
| Camera (provenance) | pitch 6.3° solved, hfov 26.1° *inferred*, heading/position *inferred* | pitch 9.1° solved, hfov 71.6° *inferred* (EXIF), heading/position *observed* (geotag) | resection from 6 picks, all *manual*: pitch 17.07°, roll 1.34°, hfov 41.9°, heading 48.57° |
| Windows hitting a facade / missed | 38 / 0 | 51 / 0 | 88 / **4** |
| Windows per plane | target edge 0: 9, target edge 4 (stoop step): **4**, neighbours 8 + 12 + 5 | target: 26, right neighbour: 25 | Ridge (edge 1): 31, Rivington (edge 2): 38, **`way/278279522` (across the street): 14**, `way/278284169`: 3, `way/278284172`: 2 |
| Within-row z spread | **0.07 m** | **0.23 m** | **0.80 m** |
| Within-column u spread | 0.04 m | 0.25 m | 0.22 m |
| Box noise (camera-free) | 4.8 px = 0.06 m | 7.7 px = 0.20 m | 8.9 px = 0.14 m |
| Median outline skew | 0.025 | 0.043 | 0.089 |
| Window width p10 / p50 / p90 | 0.61 / 1.13 / 1.49 m | 1.16 / 1.57 / 2.42 m | **0.37 / 1.22 / 2.97 m** |
| Window height p10 / p50 / p90 | 1.91 / 2.72 / 3.66 m | 1.29 / 2.01 / 2.90 m | **0.93 / 2.43 / 3.15 m** |
| Windows above the reconstructed roof | 1 (the dormer) | 2 | **6** |
| Floors × floor height → height | 5 × 4.14 → 18.3 m | 7 × 3.68 → 21.8 m | **8 × 4.22 → 28.9 m** |
| Reference height | 3D BAG ridge 22.29 m / 70th pct 18.95 m | BD TOPO 24.5 m | DoITT (via OSM) 21.4 m |

### Where the NYC skew comes from

**Camera error: dominant.** Take one storey, row by row, from left to right. Under the resection camera:

* Ridge Street facade: z = 22.89, 21.88, 21.33, 19.92, 19.13, 18.40 m.
* Continuing on Rivington Street: 18.79 … 16.89 m.

That is a monotonic tilt of about 6 m across a single storey. Detection noise cannot produce this. It is a rotation error: a roll of +1.34° where the solution is −0.57°, and a heading of 48.6° where it is 59.2°.

Splitting the variance:

* baseline spread²: 0.80²;
* best-camera spread²: 0.11²;
* box-noise floor: 0.14 m.

So **about 98 %** of the within-row variance is camera error (FOV, roll and heading together with position). The rest is at the detector noise floor.

**Plane mis-assignment, caused by the camera error.**

* The heading error moves the right edge of the frame onto `way/278279522`. That is the building across Rivington Street, whose west wall is about 8 m from the photographer. The 14 windows of 202 Rivington land there, at z ≈ 9 m.
* 4 windows miss every plane.
* 5 windows on the left go to two other Ridge Street buildings.

After alignment, all 92 windows land on the target's two facades or on 202 Rivington (`way/278284238`).

**Missing chamfer: secondary and local.** OSM models the corner as a sharp vertex, but the real building has a chamfer about 4–5 m wide with two window columns. Those windows are intersected with the side planes about 1 m in front of the real wall, so they come out about 20–30 % smaller than their row-mates (for example 1.94 m against 2.75 m in height).

Cutting a 2.5 m or 3.5 m chamfer into the footprint barely changes the aligned result: row spread 0.13 m, height 22.1–22.6 m. The chamfer explains the odd size of two columns, but not the skew.

**Box noise: about 0.14 m.** This is the floor, and regularisation removes it.

**The resection itself.** The three ground and three vertical picks fit with an rms of 33 px, which is the best the model can do with them. Under the regularity camera, the vertex-1 picks are 433 px off.

Looking at the photo, the pick at x = 414 is the end of the ornate bays and the entrance. The building's red brick continues left past it, through a fire-escape section, to behind the tree. That matches the 28 m Ridge Street edge in OSM, which fits the usual 100 ft deep corner tenement.

### Amsterdam and Paris

**Amsterdam** is at its noise floor (0.07 m spread against 0.06 m box noise). Its only plane problem is that 4 windows land on the stoop step (target edge 4). That edge lies 1 m in front of the facade and is extruded to the full height. Regularisation levels these windows with their storey.

**Paris** has 0.23 m of row spread against 0.20 m of box noise. Balcony railings and French windows make Haussmann boxes noisy. Camera error accounts for (0.23² − 0.17²) / 0.23² ≈ 45 %.

Paris also has a ground-line problem:

* The facade mask ends on top of the café awnings, so the "ground line" is about one storey up.
* `plausibleGroundline` drops the 10 of 40 samples that sit above entresol windows. The other 30 lie on awnings with no window below them.
* With the ground term switched off, regularity alone drives pitch to **18.6–19.8° from starts of 9.1°, 15° and 22°**, with column spread 0.03–0.06 m. This agrees with the 22° the fixture notes estimate from pedestrians' head heights.
* The 9.1° pitch solved from the ground line is therefore biased by the awning edge.
* Without a true ground contact, though, the metric scale comes only from the geotag distance, and the height becomes 31 m (8 × 4.1 m). Neither answer is right. See the open questions.

## 2. Algorithm

### 2.1 Image-space window grid (`windowGrid`)

* Each window links to its nearest **row neighbour** on the right when all of these hold:
  * the vertical extents overlap by at least 45 % of the smaller box;
  * the heights are within ×1.67 of each other;
  * the gap is at most 3 widths.
* **Columns** are the transpose: each window links to its nearest neighbour below when the horizontal overlap is at least 40 %, the widths are within ×1.67 and the gap is at most 2.5 heights.
* Groups are formed with union–find.

Chaining follows the slanted rows of an oblique facade and the converging columns of an upward shot. The grid does not depend on the camera, so it is computed once.

On NYC, the Python `floorRows` has only 2 rows of 35 and 57 windows, because global y-clustering fails under strong perspective. `windowGrid` finds 8 rows and 16 columns. On the synthetic corner building it recovers all 5 storeys of 9 windows and all 9 columns of 5.

### 2.2 Regularity cost (`regularityCost`)

Each term is a mean of a truncated Cauchy loss, ρ(x) = min(log(1 + x²), log 17), so terms are comparable across photos. Windows are measured exactly as `reconstruct()` does: the centre ray goes to the first facade plane hit, and the edges are measured on that plane.

| Term | Residual | σ | Weight |
|---|---|---|---|
| (i) ground | z of `plausibleGroundline` samples on the facade planes | 0.4 m | 1 |
| (ii) rows | (z − row median) / median window height, per image row ∩ building | 0.08 | 1 |
| (iii) cols | (u − column median) / median window width, per image column ∩ plane | 0.08 | 1 |
| (iv) rect | outline skew after rectification (Δu/h, Δz/w of the quad corners) | 0.08 | 0.5 |
| (iv) size | log(h / row median h), log(w / column median w) | 0.08 | 0.5 |
| coverage | fraction of windows missing every plane | — | 2 |
| points (optional) | reprojection of picked correspondences | 15 px | 1 |

The residuals for rows, columns, rectangles and sizes are **scale-free**. Moving the camera towards the facade shrinks every metric residual, so if they were in metres the optimiser could cheat by approaching the building.

`plausibleGroundline` is `effectiveGroundline` without samples that have a window ending below them within 1.5 window widths. Such samples sit on an awning, canopy or sign, not on the pavement.

### 2.3 `autoAlignCamera(view, opts)`

**Parameters.** The optimiser works on pitch, roll, hfov, heading offset, position along the target facade's normal, and position along the facade. A parameter is free only if its provenance is not *manual*. Roll follows the pitch provenance.

**Hard bounds:**

| Parameter | Bounds |
|---|---|
| hfov | 20–110°, or `opts.hfovRange` |
| pitch | −20° to 50° |
| roll | ±10° |
| heading | ±25° |
| position | ±25 m along each axis |

**Priors.** Weight 0.05 per σ². The σ values depend on provenance:

| Parameter | observed | inferred / map | assumed |
|---|---|---|---|
| pitch | 1.5° | 4° | 12° |
| roll | 1° | 2° | 4° |
| hfov | 2° | 5° | 20° |
| heading | 4° | 6° | 15° |
| position | 4 m | 6 m | 12 m |

**Scale prior.** A near-frontal photo hardly separates FOV from distance, and the regularity terms are scale-free. So log(distance × tan(hfov/2)) is held near its input value, with σ = 5 % (observed), 10 % (inferred) or 30 % (assumed), taking the weaker of the position and hfov provenances.

**Optimiser.** Nelder–Mead, deterministic, with up to 3 restarts from the best point using a shrinking, reflected simplex and 350 evaluations per run. It uses no dependencies. In node it takes 60–190 ms per call: synthetic 60 ms, Amsterdam 68 ms, Paris 100 ms, NYC 170 ms.

**Acceptance.** A result is returned only when both of these hold:

* the cost improves by at least `minImprovement` (5 %);
* the metric misalignment improves by at least `minSpreadGain` (5 cm) **and** by at least 20 %. The misalignment is the within-row z spread plus the within-column u spread from `diagnoseWindows`.

The second test stops the optimiser from "improving" photos whose windows already line up to a few centimetres. For example, Amsterdam's best candidate reaches 10.8 cm against 11.5 cm and is refused.

**Output.** Changed parameters get provenance *inferred*, and a note "Auto-aligned from facade regularity: …" is added to `camera.notes`. `terms` reports every term before (suffix `0`) and after, together with `prior`, `improvement`, `spread0` and `spread`.

### 2.4 `solveFromCorrespondences(view, points, opts)`

This is a port of `scripts/solve_camera.py`.

* **Ground points** give a 2D reprojection residual.
* **Vertical points** give only a horizontal residual. The height z at which the vertical line through the vertex reaches the clicked row is found in closed form, then the columns are compared.
* The solver is a bounded Levenberg–Marquardt with a numeric Jacobian on scaled variables. It starts once from the input camera, then 4 more times at FOV values spread across `hfovRange` (default 25–100°).
* Bounds: position within ±40 m of the start, heading ±30°, pitch −20° to 50°, roll ±10°.
* A weak prior (1 px per 20 m, 20° or 30° of FOV) keeps degenerate configurations well posed.

How many parameters are solved depends on the number of equations (2 per ground point, 1 per vertical point):

| Equations | Solved |
|---|---|
| 6 or more | full pose |
| 4–5 | orientation and FOV; position fixed |
| 2–3 | heading and pitch only |

Changed parameters become *manual*. `camera.alignment = { points, rms, method }` is filled in. `terms` reports `rms0`, `rms`, `rmsGround` and `rmsVertical`.

### 2.5 `regularizeFacadeWindows(windows, opts)`

* **Storeys, per building across all its facades.** Floors are level around a corner. Rows come from `opts.grid` (image rows), and windows not in the grid fall back to z-gap clustering with a gap of max(0.6 m, 0.5 × median height). Each window's z and height snap to the row median.
* **Columns, per facade.** Columns come from the image columns, falling back to u clustering with a gap of max(0.5 m, 0.6 × median width). u snaps to the column median, but only for columns of at least 2 windows. Width snaps to the column median, or to the row median for a singleton.
* **Safety.**
  * A coordinate snaps only if it moves 0.6 m or less (`maxMove`).
  * The total move of a centre is capped at `maxMove`.
  * Windows centred outside [0, length] of their facade are dropped. Overhanging windows are pulled in, then narrowed if needed.
  * Duplicates are merged; a manual window wins.
  * *Manual* windows are never moved but still inform the medians.
* **Output.** Every window that was processed is flagged `regularized: true`.

### 2.6 `minHeightFromWindows(windows, buildingId)`

Returns the top of the highest window of the building plus 0.3 m, or `null` if the building has no windows.

## 3. Results

### 3.1 Synthetic tests (exact ground truth)

The test scene is a 12 × 16 m corner building, 20 m tall, with 5 storeys of 1.2 × 1.8 m windows. It is photographed from the south-west at pitch 18°, roll 0.8° and hfov 60°.

| Test | Result |
|---|---|
| Auto-align from pitch +5°, roll −2.5°, hfov +10° (all *assumed*), clean boxes | errors 0.003° / 0.001° / 0.04°; cost 4.22 → 0.09 |
| Same, boxes jittered by ±3 px | errors 0.07° / 0.0002° / 0.10°; cost 4.27 → 0.32 |
| Same camera, all *manual* | unchanged |
| Resection: 3 ground + 3 vertical points, start 3.6 m / 6° / 6° / 2.3° / 12° off | pose within 0.3 m / 0.3°, rms < 1 px |
| Resection with 3 equations | heading and pitch recovered, position kept |
| Regularisation, noisy 5 × 5 grid | snaps exactly to the clean grid |
| Regularisation, 0.42 m snap with `maxMove` 0.3 | refused |
| Regularisation, window off the facade | dropped |
| Regularisation, manual window | untouched |
| Regularisation, row tilted 0.25 m per window | levelled with `grid` |

### 3.2 Curated fixtures

The table shows the baseline camera (for NYC, the resection), then `autoAlignCamera` with default options (manual parameters respected, `hfovRange` from `data/calibration` where it exists), then the windows after `regularizeFacadeWindows(…, {grid})`.

The **relaxed** columns treat a *manual* provenance as *inferred*. That is the recommendation for maintainer-resected fixtures (§4.4).

| | Amsterdam | Paris | New York (default) | New York (relaxed) |
|---|---|---|---|---|
| Accepted | no ("already within 11 cm") | yes | no (all manual) | **yes** |
| Camera change | — | pitch 9.1 → 10.6°, roll 0 → 0.2°, hfov 71.6 → 78.6°, heading 353.5 → 348.7°, 2.1 m closer, 2.1 m along | — | roll 1.34 → −0.57°, heading 48.6 → 59.2°, 10.2 m along the facade, 0.7 m back; pitch 17.1°, hfov 41.9° (at the EXIF bound) |
| Cost | 1.97 → 1.97 | 3.02 → 2.68 | 5.44 → 5.44 | **5.44 → 3.03** |
| Row z spread | 0.07 m | 0.23 → 0.17 m | 0.80 m | **0.80 → 0.11 m** |
| Column u spread | 0.04 m | 0.25 → 0.16 m | 0.22 m | 0.22 → 0.18 m |
| Windows on a wrong building / missed | 0 / 0 | 0 / 0 | 14 + 5 / 4 | **0 / 0** |
| Window size p50 (w × h) | 1.13 × 2.72 m | 1.62 × 2.21 m | 1.22 × 2.43 m | **0.95 × 1.84 m** |
| Floors × floor height | 5 × 4.14 m | 7 × 3.96 m | 8 × 4.22 m | **6 × 3.16 m** |
| Target height (reference) | 18.3 m (22.29 ridge / 18.95 70th pct) | 21.8 → **23.6 m** (24.5) | 28.9 m (21.4) | **21.3 m** (21.4) |
| Windows > 10 cm off their row: raw → regularised | 11 → 0 | 19 → 1 | 68 → **37** | 35 → **0** |
| Windows above the roof: before → with `minHeightFromWindows` | 1 → 0 | 2 → 0 | 6 → 0 | 0 → 0 |

**Paris with an EXIF-bounded FOV** (hfovRange = [0.5, 1.05] × 71.6°): pitch 9.9°, hfov 75.2°, heading 348.9°, height 22.8 m, row/column spread 0.15 / 0.19 m. The unbounded result asks for a *wider* FOV than the EXIF focal length allows, which only makes sense with a wrong ground line or lens distortion. Bounding the FOV is the safer default.

## 4. Integration

### 4.1 `web/src/lib/reconstruct.ts`

1. **Ground line.** `groundResidualFor()`, which `calibratePitch()` uses, takes its samples from `plausibleGroundline(scene)` rather than `effectiveGroundline(scene)`. It drops samples on awnings that sit above windows, and leaves fixtures without such samples unchanged.
2. **Regularised 3D windows.** At the end of `reconstruct()`, after the `// ---- 3D windows` loop has filled `windowsOut`, and when `settings.regularizeWindows` is on, the windows go through `regularizeFacadeWindows(windowsOut, { footprints: scene.footprints, grid })`. `grid` holds the image rows and columns of every view (`windowGrid`). Each window's floor is then recomputed from the snapped z: `floor = max(0, floor((z − groundFloorExtra) / floorHeight))`. Method A, the row spacing, uses the raw hits, so the height estimate is unaffected by the snapping.
3. **No window above a roof.** Using the regularised windows, each building's height is checked against `minHeightFromWindows(windows, id)`:
   * a *manual* height is kept, with the warning "Windows of {id} reach {hMin} m, above the manual height {h} m.";
   * otherwise the height is raised to `hMin` (`low` and `high` raised with it), and the note "Raised to clear the highest detected window (top + 0.3 m)" is appended.

   Amsterdam's dormer lifts the height to the dormer top. That is correct for shading, since the dormer is part of the roof volume.

### 4.2 `web/src/state/store.ts` → `loadScene` (and the per-view cameras)

`loadScene` prepares the primary camera and every `extraViews` camera with `calibrateViewCamera` (`reconstruct.ts`): an *assumed* pitch is solved by `calibratePitch`, then

```ts
const al = autoAlignCamera({ ...view, camera, detections }, { hfovRange: hfovRangeFor(camera) });
if (al.changed) camera = al.camera; // provenance → 'inferred', note added to camera.notes
```

* **When it changes anything.** Only when at least one of pitch, hfov, heading or position is not *manual*. Otherwise `autoAlignCamera` returns `changed: false` with the note "All camera parameters are manual".
* **Acceptance threshold.** The defaults (X = 5 %): the cost must improve by at least 5 %, and the metric misalignment must drop by at least 5 cm and at least 20 %. Otherwise the result has `changed: false` and the camera is kept.
* **`hfovRange`** (`hfovRangeFor`):
  * the camera's own `CameraParams.hfovRange` when set. NYC carries `[41.9, 61.6]` (`data/calibration/nyc-ridge-street.json`);
  * for an EXIF-derived FOV, `[0.5, 1.05] × hfov`. A crop narrows the FOV; nothing widens it;
  * undefined for an *assumed* FOV.

  A derived range is persisted on the camera, so later re-alignments keep the same bounds.
* **Cost and reset.** A call takes 60–190 ms. The aligned camera is stored as the view's reference camera, as for the solved pitch, so "Reset camera" returns to it.
* **UI action.** `autoAlignView(viewId)` backs "Auto-align from windows" in the Camera tab. It runs `autoAlignCamera` on the current camera (manual parameters stay fixed), reports `notes` and `terms.spread0 → terms.spread` in a toast, and is undoable.

### 4.3 Correspondence picking (for photos where regularity is not enough)

The photo panel's align mode (`web/src/components/photo/AlignCheck.tsx`) works as follows.

* It draws the projected footprints using `worldToPixel` on `cameraBasis`: the ground ring at z = 0 and the vertical edges up to the current height.
* Every target-building vertex that projects inside the image has a draggable handle.
* Dropping a handle on the photo creates an `AlignPoint { buildingId, vertex, px, kind, source: 'manual' }`:
  * `kind: 'ground'` for a street-level corner, where the corner meets the pavement;
  * `kind: 'vertical'` for a point anywhere on the vertical corner edge, when its foot is hidden. Holding Alt while dropping gives the other kind.
* After each drop, once there are at least 2 equations (2 per ground point, 1 per vertical point), `solveFromCorrespondences(view, points, { hfovRange })` re-solves the camera, which is applied live with its provenance, `alignment.points` and `rms`.
* Each point's residual is drawn as a short line from the click to the reprojection. Placed points can be moved with the arrow keys and removed with Delete.
* `result.notes` carry the equation-count hint below 6 equations and the warning above 25 px.

**Pick guidance in the UI text:**

* Prefer ground contacts at both ends of the facade.
* **Do not pick a corner you cannot see.** NYC's vertex 1 shows why (§1).

**Refining with windows.** Auto-fit is a joint fit: the picks become a reprojection term with σ = 15 px under a truncated robust loss, so one bad pick cannot dominate.

* It calls `autoAlignCamera({ ...view, camera: { ...camera, provenance: <manual → inferred> } }, { points, hfovRange })`. The picks, not the provenance, hold the camera.
* With `includeManual: true` the manual parameters keep a σ of half the *observed* value, which is too stiff to move past a bad pick.
* On NYC, the relaxed joint fit reaches a row spread of 0.13 m and a height of 22.7 m, and treats the vertex-1 picks as outliers. With `includeManual` it is refused, because the spread improves by less than 20 %.

**Store:** points live in `camera.alignment.points`, and every change to them re-solves the camera.

### 4.4 Fixtures (`scripts/` and `web/public/examples/nyc-ridge-street`)

The NYC resection is marked *manual* only because maintainers picked the points. It is not a user correction, and one of its picks (vertex 1) is wrong. There are two ways to resolve it:

* **(a)** Re-pick without vertex 1, which is off-frame or behind the tree, and add window-free ground contacts (for example the 202 Rivington boundary). Then re-run `scripts/solve_camera.py`.
* **(b)** Use the camera found by `autoAlignCamera` (relaxed provenance, hfovRange [41.9, 61.6]) with provenance *inferred* and a note:

  position `[-33.774, -24.087]`, heading **59.15°**, pitch **17.09°**, roll **−0.57°**, hfov **41.90°**.

  With this camera, the projected 21.4 m OSM outline matches the parapet, the corner and the 202 Rivington boundary. Because the provenance is not *manual*, `loadScene` keeps auto-aligning it.

The shipped NYC fixture uses (b).

## 5. Open questions

* **Paris ground line.**
  * The facade mask ends on the café awnings, so both `calibratePitch` and the ground term pull pitch to about 10°. Regularity and the pedestrians' head heights both say about 20°.
  * A real street contact is needed: the lower edge of the `street` mask meeting the facade columns, pedestrians' feet, or an `awning` class.
  * Without one, Paris heights are only as good as the geotag distance: 23.6 m with the awning ground line, 31 m without it, against BD TOPO's 24.5 m.
* **NYC FOV at the lower bound.** The relaxed solution sits at hfov 41.9°, the lower bound. Unconstrained, regularity prefers about 32°, which is impossible for this crop of a 29 mm-equivalent lens. The likely cause is model error elsewhere: the chamfer, OSM edge positions, or a slight bulge of the façade.
* **Stepped OSM footprints.** Amsterdam's stoop edge is extruded to the full height. Splitting such edges by height, or ignoring edges shorter than about 3 m that lie within about 1.5 m of a parallel longer edge when assigning windows, would remove that plane mis-assignment.
* **Multi-view.** With `extraViews`, the same building seen in two photos should share its storey grid. A joint regularity term across views would constrain both cameras.
* **Misalignment warning.** `ReconstructionResult` could carry `alignmentSpread: diagnoseWindows(...).rowZSpread + colUSpread`. A warning above about 0.3 m ("windows do not line up; the camera is probably misaligned — try Auto-align") would make this failure visible to users.
