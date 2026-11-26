# Extra views of the surroundings (multi-view obstacles)

Each curated example has one primary photo of the target facade. From that photo alone, the buildings that shade the
facade, meaning those across the street or canal and the immediate neighbours, are known only from OpenStreetMap
footprints and tags. This note documents the openly licensed **surroundings photographs** stored as `PhotoView`s in
`scene.base.json` → `extraViews`. With them, obstacle facades are measured from vision (RF-DETR detections, roofline and
ground line, depth) like the target is.

* Scripts: [`scripts/add_views.py`](../../scripts/add_views.py) (`fetch`, `build`, `plot`) and
  [`scripts/analyze_view.py`](../../scripts/analyze_view.py) (Roboflow and depth for one view).
* Provenance per view: `data/raw/<id>/views/manifest.json` (original URL, original and shipped SHA-1, license, EXIF
  subset, Commons `{{Location}}` template), raw Commons API response `data/raw/<id>/views/<viewId>/commons_api.json`,
  unmodified Roboflow response `data/raw/<id>/views/<viewId>/roboflow_raw.json` + `roboflow_meta.json`, and the plan
  plot `data/raw/<id>/views/views_plan.png`.
* Shipped fixtures: `web/public/examples/<id>/views/<viewId>/{photo.jpg, analysis.json, depth.png, depth16.bin}`.
  Photos are ≤ 2000 px on the long side, JPEG q88, and carry no EXIF, XMP or ICC data (re-created from pixels).
  Originals are not stored; `fetch` re-downloads them and verifies the Commons SHA-1.

## Reproduce

```bash
cd api
uv run python ../scripts/add_views.py fetch                       # Commons API + originals (SHA-1 checked)
uv run --extra depth python ../scripts/analyze_view.py <id> <viewId>   # replays data/raw/... if present
uv run python ../scripts/add_views.py build                       # patches ONLY "extraViews" into scene.base.json
uv run python ../scripts/add_views.py plot                        # data/raw/<id>/views/views_plan.png
```

`build` refuses to write if any field other than `extraViews` would change, so the primary cameras and the rest of
`scene.base.json` stay byte-for-byte as they are. `scripts/build_scene.py` is only *imported*, for
its exact WGS84 → ECEF → ENU transform and its 2D ray-cast helpers. It is never run.

## Method

1. **Search.** Commons `list=geosearch` (namespace 6, radius 300 m, primary/camera coordinates) around each scene
   origin returned 500, 500 and 285 files for Amsterdam, Paris and NYC. Candidates were converted to the scene's ENU
   frame and filtered by position relative to the photographed facade. For about 20 candidates per example, one
   batched `prop=imageinfo|revisions|coordinates` query read the license, size, EXIF and the `{{Location}}` wikitext
   (heading parameter). Thumbnails were downloaded and inspected by eye before anything was chosen. The requests
   used a generic User-Agent, `maxlag=5`, retries with back-off on 429, and pauses between requests.
2. **Camera.**
   * *Camera geotag* (`{{Location}}` with a heading): the position is the geotag converted to scene ENU, and the
     heading comes from the template. Both are `observed`.
   * *Subject geotag* (the Evert100 Amsterdam series tags the house's address point, with a meaningless `heading:N`):
     the subject footprint is the one containing or nearest the geotag. The camera sits on that facade's outward
     normal at a stand-off distance, and the heading is the reverse normal. Both are `inferred`. The stand-off is
     measured from the photo (see Amsterdam).
   * hfov comes from EXIF `FocalLengthIn35mmFilm` with the 43.27 mm diagonal convention. For a 3:2 landscape frame
     this equals `2·atan(36 / 2f)`. On a 4:3 frame it is slightly narrower, which is why the diagonal is used,
     matching `data/examples.config.json`. For edited or cropped files the crop is accounted for, or the alternative
     is stated in `camera.notes`.
   * Pitch 8°, roll 0 and lens height 1.6 m are `assumed`. The web app solves pitch from the detected ground line.
3. **Target, visible buildings.** These come from a 2D ray cast against the scene footprints. The optical axis's
   first hit gives `targetBuildingId` and `facadeEdgeIndex`. Rays across the FOV (121 rays, ≤ 120 m) give
   `visibleBuildingIds`.
4. **Inference.** Real hosted Roboflow inference used `building-facade-segmentation-instance/4` (RF-DETR-Seg 2XL),
   confidence 0.3, on the shipped 2000 px photo. Depth Anything V2 Small ran locally through the same
   `sunvision_cv.analysis.build_analysis` path as `analyze_example.py`. `analysis.depth.url` and `binUrl` are
   relative to the **example** folder (`views/<viewId>/depth16.bin`). The five views take **5 hosted calls in total**.

## Views

### Amsterdam, Herengracht 256: 2 views across the canal

The target facade faces east (bearing 90°) onto the Herengracht. Its morning sun comes across the canal, so the
obstacles are the east-quay houses about 42 m opposite.

| viewId | Photo | License | Camera | Target / visible | Detections |
|---|---|---|---|---|---|
| `across-canal-261` | [File:Herengracht 261.JPG](https://commons.wikimedia.org/wiki/File:Herengracht_261.JPG), Evert100, 2011-01-03 15:49 | CC0 1.0 | inferred (24.5, 4.1) m, heading 94.0°, hfov 26.1° (56 mm eq.) | `way/266695085` (Herengracht 261) edge 0; visible `way/266695027`, `way/266695038`, `way/266695086` | 36 window, 1 facade, 2 vegetation, 1 street, 1 non-building-infrastructure |
| `across-canal-263` | [File:Herengracht 263.JPG](https://commons.wikimedia.org/wiki/File:Herengracht_263.JPG), Evert100, 2011-01-03 15:50 | CC0 1.0 | inferred (24.0, −2.7) m, heading 93.2°, hfov 21.9° (67 mm eq.) | `way/266695086` (Herengracht 263) edge 0; visible `way/266695085`, `way/266695123` | 21 window, 1 facade, 3 balcony-fence, 3 vegetation, 2 car, 1 street, 1 non-building-infrastructure |

* These come from the same photographer, camera (Nikon COOLPIX L110) and series as the primary photo. They are
  frontal views of the houses directly opposite Herengracht 256, taken from the target's own quay, so the camera
  looks away from the target facade.
* **Stand-off measured, not assumed.** In the 960 px thumbnail, no. 261's facade (OSM edge 5.24 m) spans about 0.34
  of the frame width. At hfov 26.1° that puts the camera 5.24 / (0.34 · 2·tan 13.05°) ≈ 33 m away. No. 263 (6.11 m,
  about 0.48 of the frame, hfov 21.9°) also gives about 33 m. Both cameras therefore sit at the west quay wall, at
  the tree line (e ≈ 24), consistent with the boats and the water in the foreground.
* Caveats:
  * The analysis warns that the facade mask touches the top border. The *neighbours'* roofs (the white no. 259 in
    261, and nos. 261 and 265 in 263) are cropped, while the centre houses' gables are complete.
  * Herengracht 256's own primary camera uses a 40 m stand-off from the same canal geometry. The ~33 m found here
    suggests that value may be a few metres long.

### Paris, 21bis Boulevard Diderot: 2 views to the south and south-west

The target facade faces about 170° (south). Across Boulevard Diderot stand Gare de Lyon and the 67 m
*Tour de l'Horloge*. To the south-west, across Rue de Lyon, stands the *Le Mistral* office building.

| viewId | Photo | License | Camera | Target / visible | Detections |
|---|---|---|---|---|---|
| `gare-de-lyon-south` | [File:Vue de la gare de Lyon (Paris) sous la pluie en juin 2023.JPG](https://commons.wikimedia.org/wiki/File:Vue_de_la_gare_de_Lyon_(Paris)_sous_la_pluie_en_juin_2023.JPG), Benoît Prieur, 2023-06-22 09:03 | CC0 1.0 | observed (17.3, −36.9) m (about 25 m in front of the target facade), heading 172.5° (compass), hfov 62.7° | `way/1161318094` (Gare de Lyon) edge 31; visible `way/115948339` (Tour de l'Horloge, 67 m tag), `way/115948491`, `way/78158884` | 53 window, 3 facade, 2 balcony-fence, 5 vegetation, 5 traffic-infrastructure, 1 car, 1 street |
| `rue-de-lyon-southwest` | [File:Place Combattants Afrique Nord - Paris XII (FR75) - 2021-05-23 - 1.jpg](https://commons.wikimedia.org/wiki/File:Place_Combattants_Afrique_Nord_-_Paris_XII_(FR75)_-_2021-05-23_-_1.jpg), Chabe01, 2021-05-23 17:46 | CC BY-SA 4.0 | observed (−15.9, −17.4) m (at the target's south-west corner), heading 216.2° (compass), hfov 67.3° (26 mm eq., uncropped iPhone XS) | `way/78158884` (Le Mistral, office, 4 levels / 14 m tag) edge 6; nothing else within 120 m in the FOV | 79 window, 1 facade, 7 car, 3 vegetation, 5 traffic-infrastructure, 1 street |

* **Independent check of the camera** (not used as input): in `gare-de-lyon-south` the clock tower sits at 0.646 of
  the frame width. That is 10.1° right of the axis, or a bearing of 182.6°. The tower footprint's centroid lies at a
  bearing of 181.9° and 111 m from the geotag. Position, compass heading and hfov therefore agree to within 1°.
* `gare-de-lyon-south` was edited in GIMP (3690×2898 out of the 4032×3024 iPhone 13 frame). hfov 62.7° assumes the
  crop kept the pixel scale; the full frame would be 67.3°. The check above supports this assumption.
* Caveats:
  * In `gare-de-lyon-south` the model labels **two pedestrians as `balcony-fence`**. These are false positives, kept
    as recorded and not edited out. They lie below the ground line, so a user can delete them in the app.
  * The office towers behind the station are mostly beyond the 120 m ray-cast limit, so they are not in
    `visibleBuildingIds`.

### New York, 106 Ridge Street: 1 view across Ridge Street

The target facade faces about 291° (WNW) onto Ridge Street. Directly opposite stands the Nathan Straus School,
PS 140 (`way/278279377`, 10.9 m OSM height). Its long east facade lines Ridge Street.

| viewId | Photo | License | Camera | Target / visible | Detections |
|---|---|---|---|---|---|
| `ps140-across-ridge` | [File:Straus School PS 140 jeh.jpg](https://commons.wikimedia.org/wiki/File:Straus_School_PS_140_jeh.jpg), Jim.henderson, 2018-03-10 16:53 | CC BY-SA 4.0 | observed (−21.1, −26.6) m (the Ridge/Rivington corner, about 20 m from the target), heading 348.75° (`NbW`), hfov 71.6° (assumed) | `way/278279377` (PS 140) edge 9 (its Ridge Street facade); visible `way/278279431`, `way/278279516`, `way/278284172`, `way/278284170`, `way/278284169` | 10 window, 1 balcony-fence, 1 shop, 1 fence, 3 vegetation, 4 traffic-infrastructure, 3 car, 1 street; **no facade** |

* This photo shows both the Rivington Street face (with the mural) and the Ridge Street face of the school, which
  is the obstacle directly opposite the target facade.
* Weak inference, reported as is:
  * **No facade was detected.** Leafless trees cover the glass-block curtain wall, so there is no roofline or ground
    line, and only 10 windows were found.
  * The single `balcony-fence` is a false positive on the school's canopy.
  * The view is still useful for manual correction: the roof edge is clearly visible against the sky.
* **Heading or position error of about 12°.** The building corner appears 3.9° right of the image centre (bearing
  about 352.6° at hfov 71.6°), while the geotag-to-footprint geometry puts it at about 340°. `NbW` is a 32-point
  label (±5.6°), and a few metres of GPS error explain the rest. Calibrate with the alignment tool.
* hfov is uncertain. The file is 3561×2671, which is 0.773× the 4608×3456 native frame on both axes, and EXIF says
  it was edited in Windows Photo Editor. It is either downscaled (71.6°, assumed) or a same-aspect crop (58.3°).

NYC has a single view. Within 300 m Commons has nothing else that shows Ridge Street's west side or the
target's neighbours (see rejected candidates below).

## Rejected candidates (selection)

| Example | File | Why rejected |
|---|---|---|
| Amsterdam | Amsterdam Canal Buildings (52555854917).jpg (CC BY 2.0) | Shot from a boat, with no heading. From the image alone it is impossible to tell which quay it shows. It is also heavily HDR-processed. |
| Amsterdam | De 9 Straatjes - panoramio (1).jpg (CC BY 3.0) | Oblique view along the east quay with no heading. It overlaps the chosen frontal views at worse geometry. |
| Amsterdam | Herengracht 257 / 269 / 271 / 275.JPG (CC0) | Same series, but further from the target's axis (nos. 269 and 271 are 23–27 m south). Two views per example is the cap; 261 and 263 are the houses directly opposite. |
| Amsterdam | Treeftsteeg - Amsterdam (NL32) - 2024-11-25 - 2.jpg | A narrow alley view that shows no obstacle facade. |
| Paris | Gare Lyon - Paris XII (FR75) - 2026-02-21 - 1.jpg (CC BY-SA 4.0) | Good camera geotag near the target (heading 146°), but the station facade was wrapped in scaffolding and an advertising tarp, and it overlaps the chosen south view. |
| Paris | Gare Lyon - Paris XII (FR75) - 2022-06-07 - 1.jpg | A 5324×2678 phone **panorama**, which breaks the pinhole model. |
| Paris | Tour Horloge Gare Lyon … (2022, 2025) | 77–120 mm eq. close-ups of the tower only, mostly at dusk. |
| Paris | Paris GareDeLyon FacadeEtTourDeLHorloge.JPG (CC BY-SA 3.0, 2005) | Good position (heading `SSE`), but a low-resolution cropped 2005 image. The chosen CC0 view covers the same sector. |
| Paris | GARE DE LYON (40018186930).jpg, Accès Station Métro … - 8.jpg | Close-ups of the entrance or the metro sign; no roofline. |
| Paris | View of the Gare de Lyon from the Diderot Boulevard.JPG (PD) | Camera about 75 m east of the target; shows mostly towers and a pedestrian in front. |
| NYC | Row houses at 89, 91, and 93 Pitt Street …; Lady of Sorrows RCC jeh.jpg; Samuel Gompers Houses (51597973080).jpg | East of the target, behind its rear and away from the west-facing facade's sky. They do not show its obstacles. |
| NYC | LES sunset.jpg, Mapillary (smartmaper) 2019-12-18 … | More than 120 m away. The Mapillary frames are along streets 100+ m north-east. |

## Integration notes

* `PhotoView.analysis` is stored inline, matching `web/src/schema/scene.ts`. The image and depth URLs
  (`views/<viewId>/photo.jpg`, `views/<viewId>/depth.png|depth16.bin`) are relative to the **example folder**.
  `web/src/lib/examples.ts` resolves `scene.image.url`, `extraViews[].image.url` and
  `extraViews[].analysis.depth.url/binUrl` against `examples/<id>/`.
* The thumbnail URLs returned by the Commons API point at `thumb.wikimedia.org`. The same paths are served from
  `upload.wikimedia.org/wikipedia/commons/thumb/...`, which is what the inspection step uses.
