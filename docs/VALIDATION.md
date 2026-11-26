# Validation against independent references

The numbers below are produced by [`web/src/lib/__tests__/examples.test.ts`](../web/src/lib/__tests__/examples.test.ts), which writes [`validation-results.json`](validation-results.json). Reproduce them with:

```bash
cd web && ./node_modules/.bin/vitest run src/lib/__tests__/examples.test.ts
```

The test loads each curated example the way the app does (`loadScene`: pitch solving, FOV inference where the FOV is assumed, then `autoAlignCamera`), reconstructs it, and compares the target building with its reference. It also reconstructs once with the unmodified fixture camera ("fixture camera" below), once in map-only mode, and once with all extra views of the surroundings.

**Reference heights are never used as inputs in vision-first mode.** They come from:

* **3D BAG** (lidar-derived, Netherlands)
* **IGN BD TOPO** (France, stated precision ±2.5 m)
* **OpenStreetMap** tags (the NYC tag was imported from NYC building footprints; the Sarajevo building has no height or levels tag at all)

We did not tune any parameter toward these references.

## Target-building height

| Example | Camera on load | Vision estimate | Range | Methods (value · weight) | Reference | Error |
|---|---|---|---|---|---|---|
| Amsterdam | geotag marked the subject → camera re-placed across the canal (*inferred*); pitch 8° (assumed) → **6.3° solved**; auto-align ran and was refused (rows already level) | **19.27 m** | 19.27–25.17 | A 21.91 · 4 % · B 18.17 · 95 % · C 24.29 · 1 %; raised from 18.4 m to clear the highest detected window | 3D BAG: ridge max 22.29 m; 70th-pct roof 18.95 m | −3.02 m (ridge) · +0.32 m (70th pct) |
| Paris | geotag position + heading (*observed*); pitch 22° (assumed) → **9.91°**; **auto-aligned**: heading 353.46° → 348.87°, roll 0° → 0.27°, hfov 71.6° → 75.2° (the EXIF-derived upper bound, 1.05 × 71.6°) | **24.12 m** | 24.12–29.07 | A 27.68 · 3 % · B 22.55 · 97 %; raised from 22.7 m to clear the highest detected window | IGN BD TOPO 24.5 m, 8 levels | −0.38 m |
| New York | fixture camera = the hand-picked resection auto-aligned from facade regularity (*inferred*, see below); on load auto-align is refused (4.7 % improvement, below the 5 % threshold) | **21.31 m** | 20.16–22.75 | A 20.16 · 8 % · B 21.41 · 92 %; depth not calibrated (too few ground samples) | OSM 21.4 m, 5 levels | −0.09 m |
| Sarajevo | resected from 2 ground + 2 vertical-edge picks on the outer corners (`data/calibration/sarajevo-obala-kulina-bana.json`; Commons geotag 6.0 m off), FOV held at the EXIF-derived 63.5°, rms 6.9 px (*inferred*); auto-align keeps it (picks stored with the camera, FOV bounded to 62.2–66.7°) | **18.20 m** | 18.20–23.53 | A 21.41 · 2 % · B 18.85 · 86 % · C 12.82 · 12 % (depth calibrated: 48 samples, rms 0.13); fused 18.17 m, raised 3 cm to clear the bay's top window | none (OSM: three `building=apartments` ways, no levels, no height) | none (see below) |

The +0.32 m against Amsterdam's 70th-percentile roof is 19.27 − 18.95; the JSON records only the ridge reference.

**Sarajevo has no reference.** No open height dataset for Sarajevo was available to us. OSM maps Obala Kulina bana 24 as three `building=apartments` ways (west wing `way/190229391`, centre `way/190229449`, east wing `way/191316850`, the target) with no `building:levels` and no `height`. The map-only value (12 m) is therefore just the app's default, not a reference. What can be said, all of it weak:

* **A photo-ratio estimate, not independent of the photo.** With the resected camera, the wings' parapet ≈ 630 px above the base works out to 17.5 m at the west outer corner and 18.2 m at the east one, and the cornice under the attic band to 16.3 m at both. (Scaling pixels by the 42.9 m OSM width as if the camera were level gives 17–17.5 m, but the camera looks up 8.9°, so the top of the facade is farther away than its base.) Our 18.20 m for the east wing agrees, but this uses the same pixels and camera, so it is a consistency check, not an error.
* **Storeys.** The east wing shows 4 window rows (window centres at about 1.9, 7.9, 13.0 and 16.7 m in the loaded camera): shopfront ground floor, arched first floor, second floor and a row of round attic windows. Method A counts 4 floors of 5.05 m, which is plausible for a representative historic building with high ceilings. Whether the oculus row is a full storey cannot be told from outside.
* **Use.** Commons files the building as "Former police station on obala Kulina bana", under "Government buildings in Sarajevo". OSM's `building=apartments` on all three pieces may be a bulk default. The apartment in the demo is an assumption.

### Effect of camera calibration on load

"Fixture camera" is the camera stored in `scene.base.json`. "Loaded camera" is what `loadScene` makes of it. Both are reconstructed with the same code (window regularisation and the window-height floor included).

| Example | Height · error, fixture camera | Height · error, loaded camera | Ground-line residual before → after |
|---|---|---|---|
| Amsterdam | 20.7 m · −1.59 m (ridge) | 19.27 m · −3.02 m (ridge) | +1.17 m → −0.01 m |
| Paris | 35.35 m · +10.85 m | 24.12 m · −0.38 m | +7.66 m → +0.02 m |
| New York | 21.31 m · −0.09 m | 21.31 m · −0.09 m | −0.02 m → −0.02 m |
| Sarajevo | 18.20 m · no reference | 18.20 m · no reference | −0.06 m → −0.06 m (pitch from the resection; nothing to re-solve) |

For Amsterdam the calibrated camera moves the estimate away from the ridge and towards the 70th-percentile roof (20.7 − 18.95 = +1.75 m with the fixture camera, +0.32 m with the loaded one). The ridge is not in the photo.

### New York: hand-picked resection vs. regularity alignment

A camera resected from 3 ground + 3 vertical-edge picks (rms 33 px, all *manual*) gives 28.9 m, +7.5 m. The window grid shows what is wrong with it. Diagnosis from [`research/alignment.md`](research/alignment.md):

| | Hand-picked resection (manual) | Regularity-aligned (used) |
|---|---|---|
| Heading · roll | 48.6° · +1.34° | 59.2° · −0.57° (moved 10.2 m along the facade, 0.7 m back; pitch 17.1° and hfov 41.9° kept) |
| Within-row z spread (robust σ) | 0.80 m (detector noise floor 0.14 m) | 0.11 m |
| Windows on a wrong building / missed | 14 on a building across Rivington Street + 5 on other Ridge Street buildings / 4 | 0 / 0 |
| Floors × floor height | 8 × 4.22 m | 6 × 3.16 m |
| Target height (reference 21.4 m) | 28.9 m | 21.3 m (this run: 21.31 m) |

About 98 % of the hand-picked camera's within-row variance is camera error, not detection noise. The FOV is bounded to the EXIF range [41.9°, 61.6°] (a 29 mm-equivalent lens on a square crop), and the solution sits at the lower bound. The resection picks for footprint vertex 1 are wrong: they mark the end of the ornate bays, not the end of the 28 m OSM edge, and are 433 px off under the aligned camera. The aligned camera is stored in the fixture with provenance *inferred* and a note; [`data/calibration/nyc-ridge-street.json`](../data/calibration/nyc-ridge-street.json) keeps the hand picks for reference.

### Floors

| Example | Ours | Reference |
|---|---|---|
| Amsterdam | 5 (measured floor-to-floor 4.14 m: tall canal-house storeys) | — |
| Paris | 7 (3.78 m) | IGN 8 · OSM 7 |
| New York | 6 (3.16 m) | OSM 5 (the building is described as 6-storey) |
| Sarajevo | 4 (5.05 m): shopfront ground floor, arched first floor, second floor, round attic windows | — (OSM has no levels) |

## Multi-view: photos of the surroundings

Five Commons photos of the buildings opposite are stored as `extraViews` ([`research/views.md`](research/views.md)). Each gets the same calibration on load, and its measurements are fused per building with every other photo.

| Example | View | Camera on load | Windows detected → placed | Buildings measured |
|---|---|---|---|---|
| Amsterdam | `across-canal-261` | auto-aligned: heading 94.01° → 97.83°, hfov 26.1° → 24.32°, pitch → 7.69° | 36 → 29 | `way/266695027`, `way/266695085` |
| Amsterdam | `across-canal-263` | pitch 8° → 7.5°; not auto-aligned | 21 → 20 (1 duplicate) | `way/266695085`, `way/266695086`, `way/266695123` |
| Paris | `gare-de-lyon-south` | auto-aligned: heading 172.47° → 174.84°, pitch 8° → −1.55° | 53 → 52 | `way/78158884`, `way/115948491`, `way/1161318094` |
| Paris | `rue-de-lyon-southwest` | auto-aligned: heading 216.17° → 210.34°, hfov 67.3° → 65.5°, pitch 8° → −1.62° | 79 → 68 (6 on the tower behind set aside by depth) | `way/78158884` |
| New York | `ps140-across-ridge` | unchanged: no facade, so no ground line to solve pitch from; auto-align refused (4.3 % < 5 % improvement) | 10 → 7 (3 on a building behind set aside by depth) | `way/278279377` |

With the extra views, buildings with photo-measured heights go from 4 to 8 in Amsterdam, from 2 to 5 in Paris and from 2 to 3 in New York. Heights that change from a map value to a photo value:

| Building | Seen in | Multi-view height (range) | Without extra views (source) | Methods used |
|---|---|---|---|---|
| `way/266695027` (Amsterdam, east quay) | 261 | 19.99 m (15.17–24.82) | 20.2 m (OSM tag) | A 15.2 + OSM tag 20.2 |
| `way/266695085` (Herengracht 261) | 261, 263 | 15.08 m (15.08–16.58) | 16.6 m (OSM tag) | A 15.9, B 14.6, A 14.4 |
| `way/266695086` (Herengracht 263) | 263 | 14.53 m (11.89–17.16) | 13.4 m (OSM tag) | A 11.9, B 14.7 |
| `way/266695123` (Amsterdam, east quay) | 263 | 16.4 m (14.6–18.2) | 16.6 m (OSM tag) | A 14.7 + OSM tag 16.6 |
| `way/78158884` (*Le Mistral*, Paris) | rue-de-lyon, gare-de-lyon | 14.06 m (14.06–19.84), 4 floors | 14 m (OSM tag; 4 levels) | A 17.5, B 15.3, C 10.5 (rue-de-lyon), A 7.5 (gare-de-lyon); fused 13.3 m, raised to clear windows |
| `way/115948491` (Paris, across the boulevard) | gare-de-lyon | 32.78 m (32.78–39.59) | 30 m (OSM tag) | A 23.2 + OSM tag 30.0; raised to clear windows |
| `way/1161318094` (Gare de Lyon) | gare-de-lyon | 20.75 m (18.81–22.92) | 7 m (2 OSM levels) | A 19.3, B 20.8 |
| `way/278279377` (PS 140, New York) | ps140 | 11.15 m (7.35–14.96) | 10.9 m (OSM tag) | A 15.0 + OSM tag 10.9 |

There is no independent reference for these obstacles, so this is a consistency check, not an accuracy claim. A building seen only in extra views and measured there by at most one method keeps its OSM height tag as an extra fused method (`Map · osm:height`), because those cameras are only roughly placed. Two views were partly set aside. In `across-canal-261` the window rows on `way/266695086` measure 2.29 m apart, which is implausible for storeys, so those 7 windows are not placed. In `ps140-across-ridge` 3 of the 10 windows are on the red-brick building seen behind the school, at the left of the photo; the depth map puts them about 2.5× farther than the school's facade (the warning rounds this to "about 3×"), so they are set aside (below).

**Depth discontinuities in the extra views.** The depth rejection that the Vilsonovo regression fixture checks (below; [RECONSTRUCTION.md](RECONSTRUCTION.md#buildings-behind-the-facade-depth-discontinuities)) affects two extra views. It does not change the target results of the published examples, and on the Sarajevo example it sets nothing aside. Both cases are the Vilsonovo failure mode in another photo:

* `rue-de-lyon-southwest` (Paris): the facade mask of *Le Mistral* includes a Gare de Lyon tower behind it. 7 roofline samples (ratio 0.28–0.47) and 6 windows on the tower (0.36) are set aside. Without the rejection those 6 windows are still not placed (they lie above the roofline B measures), but they form two extra window rows: method A counts 6 floors (25.6 m) and is excluded as inconsistent. With it, A counts the 4 storeys OSM also gives (17.5 m), and *Le Mistral* comes out at 14.06 m (14.06–19.84), 4 floors, instead of 15.79 m (14.31–17.33), 6 floors; its OSM tag is 14 m. Part of that difference is an A of 7.5 m from `gare-de-lyon-south` (two rows of its lower floors), which falls within the spread with the rejection and is excluded as inconsistent without it. The wider range reflects that disagreement.
* `ps140-across-ridge` (New York): without the rejection, the 3 windows behind the school mix into its rows, which then measure 1.77 m apart, so the photo's camera scale is blamed and all its measurements of the school are set aside. With them set aside the rows are plausible: 7 windows are placed and the school gets A 15.0 m, fused with its OSM tag 10.9 m (kept as an anchor, one photo method) to 11.15 m. The FOV of this photo is only assumed, so A is a weak measurement; the anchor keeps the result near the tag.

Mean direct sun on the target facade on 21 June, without → with extra views: Amsterdam 347 → 347 min, Paris 410 → 410 min, New York 446 → 430 min (431 without the depth rejection, when the school opposite keeps its 10.9 m OSM tag instead of 11.15 m). Sarajevo has no extra views (529 min; 574 min on 20 March, 459 min on 21 December). Its facade faces south-south-east (157.8°) across Obala Kulina bana and the Miljacka. The nearest mapped buildings in front of it, across the river (`way/190122847`, `relation/3299229`), are 44–48 m away with 4–5 OSM levels and no height, so they shade with the app's levels-based default height. The hills to the south (Trebević) are not modelled, since there is no terrain model, so the winter figure is an upper bound.

### Sarajevo: where the windows land

From the loaded (resected) camera all 58 detected windows are placed: 23 on the target (east wing), 17 on the west wing, 7 on the centre way, 9 on the balconied block at the left (`way/190229408`) and 2 on the glass-fronted neighbour at the right (`way/190229533`). The detections are shipped unedited. The camera puts the outer corners where they are in the photo, so the remaining misplacement comes from the map:

* OSM's three pieces do not follow the architecture. The 7.1 m centre way projects to x ≈ 813–1075 px, while the raised centre bay spans x ≈ 730–1190 px (≈ 13 m). So the bay's left window column (x ≈ 830 px) is counted on the centre way and its right column (4 windows, x ≈ 1064–1135 px, u = 0.8 m) on the east wing. The target's sun figures therefore average 23 windows: its own 19 (5 shopfronts, 5 arched, 5 upper, 4 round attic windows) and that bay column, which belongs to the same building and facade plane. The bay's top window (top 17.9 m) sets the 3 cm raise of the target height. The centre way's own height understates the bay (≈ 20–21 m by the photo ratio).
* The Commons geotag camera projects the facade about 19 % wider than photographed. It is 38.6 m from the facade line, while the resection puts the camera about 45 m away. From the geotag the outer corners fall at x ≈ 148 and 1978 px at street level, against ≈ 204 and ≈ 1770 px in the photo, so the blue outline runs past the east corner onto the glass-fronted neighbour. That neighbour's two highest windows (detections `dcad73a9` and `3ab51481`, boxes from x ≈ 1753 px) are then counted on the target, and everything comes out about 12 % low (17.48 m, floors at 4.31 m). From the resected camera they land on the neighbour's own footprint.
* Unconstrained, auto-alignment moves the FOV of the resected camera from the EXIF-derived 63.5° to 60.6° (a narrower FOV trades for distance and widens the outline again), and the calibrated depth falls to 13.6 m, widening the range to 13.6–21.8 m. Two constraints prevent that. The picks are stored with the camera (`camera.alignment.points`), so alignment keeps them as a reprojection term, and the FOV is bounded to what EXIF allows (62.2–66.7°: 18 ± 0.5 mm on a 22.3–23.0 mm sensor width). Alignment therefore leaves the camera where the resection put it. The calibrated depth still reads low (12.8 m) and carries 12 % of the weight. Separately, a window that raises a measured height but still fits inside that height's interval does not trigger the "check the camera" warning (`reconstruct.ts`).

The facade mask also spans both neighbours, but no roofline sample or window reads farther than the facade (the depth check sets nothing aside).

### Regression fixture: Vilsonovo šetalište

[Vilsonovo Šetalište.jpg](https://commons.wikimedia.org/wiki/File:Vilsonovo_%C5%A0etali%C5%A1te.jpg) (Fanny Schertzer, CC BY-SA 3.0) shows a war-damaged apartment block in Sarajevo. It is not a published example. Its recorded detections, depth map and scene form the offline fixture [`web/src/lib/__tests__/fixtures/vilsonovo/`](../web/src/lib/__tests__/fixtures/vilsonovo/README.md), the regression test for the depth-discontinuity rejection. RF-DETR's facade mask included the high-rise of the Parliament complex behind the block (OSM `way/23724025`, 230 m from the camera), and one "window" was detected on it (box 677,112–695,177 px). Without depth, the tower's roofline (21.2–23.1 m) and that window's sixth row (20.1 m) give **22.19 m, 6 floors**, about 4 m too high. Relative to the facade's windows the tower reads 0.27–0.33 and the false window 0.30, i.e. about 3× farther. With them set aside the block gives **18.03 m (16.68–20.2), 5 floors** (ground + 3 + dormer attic, OSM `building:levels=4`). The test in `examples.test.ts` asserts exactly this: 1 window and at least 8 roofline samples set aside, 5 floors, 17–19.5 m, and 6 floors above 21 m without the depth map.

## Interpretation

* **What is measured.** Vision measures the top of the *visible facade* (cornice or eave). Amsterdam's gable ridge is cropped out of the photo, so the closest comparable reference is 3D BAG's 70th-percentile roof height. Paris has a zinc mansard above the cornice that BD TOPO includes in its height.
* **The window-height floor matters.** In Amsterdam and Paris the fused estimate (18.4 m, 22.7 m) is below the top of the highest detected window and is raised to clear it (top + 0.3 m). That is why both ranges start at the estimate. In Amsterdam the highest window is the dormer, which is part of the roof volume, so this is right for shading.
* **Paris's ground line is on the café awnings.** `plausibleGroundline` drops ground-line samples that have a window ending below them, but most awning samples have none. With the ground term switched off, regularity alone drives the pitch to 18.6–19.8° from several starting points, close to the 22° the fixture notes estimate from pedestrians' head heights ([`research/alignment.md`](research/alignment.md) §1). The 9.91° used here is probably biased by the awnings, so the −0.38 m is partly luck. A real street-contact cue is missing.
* **New York's FOV sits at the lower EXIF bound.** Unconstrained, regularity prefers about 32°, which is impossible for this crop. The likely causes are model errors elsewhere: OSM has no chamfer at the corner, edge positions may be off, or the facade may bulge.
* **Facade masks can include a building behind.** When a taller building rises behind the target, the facade mask and roofline can include it. In the Vilsonovo photo (the regression fixture) that adds about 4 m and one false storey. The relative depth map separates the two without any calibration (the tower reads about 3× farther than the facade), and the reconstruction sets such roofline samples and windows aside. It needs a depth map, at least 3 windows for a reference, and a background at least 2× farther than the facade; a building just behind the target (less than 2× its distance) is not caught.
* **Three buildings are not a benchmark.** The ranges are heuristic and the errors above are three samples. Sarajevo adds a fourth example but no fourth error, because it has no height reference at all.

## Synthetic ground truth (unit tests)

On a synthetic 18 m building photographed from 20 m with a 14° pitch (`reconstruct.test.ts`):

* Method B recovers the true height to 0.1 m.
* Method A finds 5 floors at 3.20 m.
* Window sizes are measured within 0.15 m (box-around-trapezoid bias).
* A wrong pitch (4° instead of 14°) is recovered by ground-line calibration.

On a synthetic 20 m corner building with 5 storeys of windows, photographed at pitch 18°, roll 0.8° and hfov 60° (`align.test.ts`, [`research/alignment.md`](research/alignment.md) §3.1):

* Auto-align from pitch +5°, roll −2.5° and hfov +10° (all *assumed*) recovers the camera to within 0.06° / 0.001° / 0.13° (pitch / roll / hfov; cost 4.22 → 0.07), and to within 0.13° / 0.0004° / 0.002° with ±3 px box noise (cost 4.27 → 0.29). The test asserts only that each error drops below 30 % of its perturbation. With all parameters *manual*, it changes nothing.
* Resection from 3 ground + 3 vertical points recovers the pose to within 0.3 m / 0.3° with rms < 1 px.
* Regularisation snaps a noisy 5 × 5 grid exactly to the clean grid, refuses a 0.42 m snap with `maxMove` 0.3, drops a window off the facade and never moves a manual window.
