# Data sources, provenance and licensing

sunvision-ai's curated examples are built only from openly licensed data. Everything is reproducible:
raw API responses are stored under `data/raw/<example-id>/`, curation decisions live in
`data/examples.config.json`, and `scripts/build_scene.py` regenerates every `scene.base.json`.
The machine-readable manifest is [`data/manifest.json`](../data/manifest.json).

> The application **code** is licensed separately (see `LICENSE`). The licenses below apply to the
> data and model outputs shipped as demo fixtures, and they travel with any redistribution of them.

## Photographs (Wikimedia Commons)

| Example | File | Creator | License | Captured | Camera |
|---|---|---|---|---|---|
| `amsterdam-herengracht` | [Herengracht 256.JPG](https://commons.wikimedia.org/wiki/File:Herengracht_256.JPG) | Evert100 | CC0 1.0 | 2011-01-24 13:35 | Nikon Coolpix L110, 56 mm eq. |
| `paris-boulevard-diderot` | [Immeuble 21bis Boulevard Diderot - Paris XII (FR75) - 2026-03-20 - 1.jpg](https://commons.wikimedia.org/wiki/File:Immeuble_21bis_Boulevard_Diderot_-_Paris_XII_(FR75)_-_2026-03-20_-_1.jpg) | Chabe01 | CC BY-SA 4.0 | 2026-03-20 14:34 | iPhone 16 Pro, 24 mm eq. |
| `nyc-ridge-street` | [Apartment building at 106 Ridge Street, Lower East Side, Manhattan - 20200906.jpg](https://commons.wikimedia.org/wiki/File:Apartment_building_at_106_Ridge_Street,_Lower_East_Side,_Manhattan_-_20200906.jpg) | Andre Carrotflower | CC BY-SA 4.0 | 2020-09-06 12:22 | iPhone 6s Plus, 29 mm eq. (square crop) |
| `sarajevo-obala-kulina-bana` | [Sarajevo – Obala Kulina bana 24.jpg](https://commons.wikimedia.org/wiki/File:Sarajevo_%E2%80%93_Obala_Kulina_bana_24.jpg) | Julian Nyča ([User:J budissin](https://commons.wikimedia.org/wiki/User:J_budissin)) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | 2015-08-02 14:30 (EXIF, no time zone) | Canon EOS 550D, 18 mm on APS-C ≈ 29 mm eq. (no 35 mm field in EXIF) |

**Transformations** (applied by the fixture pipeline, recorded per image in `scene.base.json → image.attribution.transformations`):
downscaled to at most 2000 px on the long side (Lanczos), re-encoded as JPEG quality 88, all EXIF/XMP
metadata stripped. The EXIF fields sunvision-ai uses (make, model, focal length, capture time) were read from the
Commons original first and are recorded in `data/raw/exif.json`. Original SHA-1 hashes are in `data/manifest.json`.
For Sarajevo the 3500×2333 original (SHA-1 `293237bded988e484a67f479c3ff4d3a224026a7`, equal to the Commons API
value) was turned upright with `exif_transpose` (a no-op, Orientation 1), downscaled to 2000×1333 and saved without
metadata. The original has no GPS and no ICC profile. The shipped `photo.jpg` has SHA-1
`8471191858d0dc1355bafbd7d3f4c985aeef100a` and is byte-for-byte reproducible from the original with Pillow (Lanczos,
quality 88). Its Roboflow response was recorded once, on this exact file
(one hosted call, not retried; 6.7 s wall clock), and is replayed from
`data/raw/sarajevo-obala-kulina-bana/roboflow_raw.json`. The full Commons record (wikitext templates, `{{Location}}`,
API coordinates with `type: camera`, the uploader's terms template, categories) is in `data/raw/commons_metadata.json`.
A second Sarajevo photo, *Vilsonovo Šetalište.jpg* (Fanny Schertzer, CC BY-SA 3.0), is not a published example. Data
derived from it (detections, depth, scene; no photo) serve as a test fixture with their own attribution in
[`web/src/lib/__tests__/fixtures/vilsonovo/README.md`](../web/src/lib/__tests__/fixtures/vilsonovo/README.md).

**Obligations.** CC BY-SA 4.0 and 3.0 photographs require attribution (creator, title, link, license) and indication
of changes; adaptations of the *photo itself* must be shared under CC BY-SA (for the Sarajevo photo: CC BY-SA 3.0 or a
compatible later version). The Sarajevo photographer's terms template on the file page (`{{User:J budissin/Terms}}`, German/Sorbian)
asks for the author's name and the licence at an appropriate place near the image, and states that the rights lapse
automatically if the licence terms are breached. The app shows the credit line (author and licence) under the landing stage for the selected example and
in the photo panel, and the Inspector shows title, author, licence and source link. CC0 requires nothing, but we credit the author anyway.

**Privacy.** The Paris and NYC photos show incidental pedestrians (one face in the Paris photo is already
blurred in the Commons original). The Sarajevo photo shows no people, only shop signs and graffiti at street level. sunvision-ai never detects or identifies people; the facade model has no person
class.

**Camera geotags.** Camera locations and compass headings come from the Commons `{{Location}}` templates,
which are photographer-supplied and of unknown accuracy. For Amsterdam the geotag matches the subject's
address point rather than the photographer's position, so the camera was re-placed on the opposite quay and
flagged `inferred` (details in the example's `camera.notes`). For New York the shipped camera is the maintainer
resection (`data/calibration/nyc-ridge-street.json`) refined by facade-regularity auto-alignment and flagged
`inferred`; the derivation is in `camera.notes` ([research/alignment.md](research/alignment.md) §4.4). For Sarajevo the
camera itself recorded no GPS. The uploader's Commons `{{Location|43.856692|18.425885}}` is a camera location (the API
lists it as `type: camera`), on the south bank of the Miljacka about 39 m from the facade line. From there the footprints
project about 19 % wider than the photographed facade, so, as for New York, the shipped camera is resected from 4 picked
correspondences on OSM nodes 2008185172 and 2008184871 (both base corners plus the same vertical edges under the cornice;
`data/calibration/sarajevo-obala-kulina-bana.json`, solved with `scripts/solve_camera.py`). The FOV is held at the
EXIF-derived 63.5°. The result is 6.0 m from the geotag, about 45 m from the facade line, heading 340.6° (rms 6.9 px),
flagged `inferred`, with the picks stored on the camera so auto-alignment keeps them (details in `camera.notes` and
[VALIDATION.md](VALIDATION.md#sarajevo-where-the-windows-land)).

## Photographs of the surroundings (extra views)

Five more Wikimedia Commons photographs show the buildings that shade the Amsterdam, Paris and New York target
facades (Sarajevo has none: across the Miljacka the nearest mapped buildings in front of its facade are 44–48 m
away, behind the camera). They are stored as
`extraViews` in each `scene.base.json`, with their own recorded Roboflow inference and depth. Method, cameras
and rejected candidates: [research/views.md](research/views.md). Per-file provenance (Commons file page, original
URL, original and shipped SHA-1, license, EXIF subset, `{{Location}}` template, transformations):
`data/raw/<example-id>/views/manifest.json`, plus the raw Commons API response in
`data/raw/<example-id>/views/<viewId>/commons_api.json`.

| Example | viewId | File | Creator | License | Captured (EXIF) | Camera |
|---|---|---|---|---|---|---|
| `amsterdam-herengracht` | `across-canal-261` | [Herengracht 261.JPG](https://commons.wikimedia.org/wiki/File:Herengracht_261.JPG) | Evert100 | CC0 1.0 | 2011-01-03 15:49 | Nikon Coolpix L110, 56 mm eq. |
| `amsterdam-herengracht` | `across-canal-263` | [Herengracht 263.JPG](https://commons.wikimedia.org/wiki/File:Herengracht_263.JPG) | Evert100 | CC0 1.0 | 2011-01-03 15:50 | Nikon Coolpix L110, 67 mm eq. |
| `paris-boulevard-diderot` | `gare-de-lyon-south` | [Vue de la gare de Lyon (Paris) sous la pluie en juin 2023.JPG](https://commons.wikimedia.org/wiki/File:Vue_de_la_gare_de_Lyon_(Paris)_sous_la_pluie_en_juin_2023.JPG) | Benoît Prieur | CC0 1.0 | 2023-06-22 09:03 | iPhone 13, 26 mm eq. (edited in GIMP, 3690×2898 crop) |
| `paris-boulevard-diderot` | `rue-de-lyon-southwest` | [Place Combattants Afrique Nord - Paris XII (FR75) - 2021-05-23 - 1.jpg](https://commons.wikimedia.org/wiki/File:Place_Combattants_Afrique_Nord_-_Paris_XII_(FR75)_-_2021-05-23_-_1.jpg) | Chabe01 | CC BY-SA 4.0 | 2021-05-23 17:46 | iPhone XS, 26 mm eq. |
| `nyc-ridge-street` | `ps140-across-ridge` | [Straus School PS 140 jeh.jpg](https://commons.wikimedia.org/wiki/File:Straus_School_PS_140_jeh.jpg) | Jim.henderson | CC BY-SA 4.0 | 2018-03-10 16:53 | Nikon Coolpix P610, 24 mm eq. (edited in Windows Photo Editor) |

* **Transformations** (recorded in each manifest): downscaled to at most 2000 px on the long side (Lanczos),
  re-encoded as JPEG quality 88, all EXIF/XMP/ICC metadata stripped. Originals are not stored;
  `scripts/add_views.py fetch` re-downloads them and checks the Commons SHA-1.
* **Capture dates.** The Amsterdam manifests' `dateTimeOriginal` field reads 2011-01-05 (the Commons page);
  the table uses the EXIF `DateTimeOriginal` (2011-01-03), which is also what `research/views.md` reports.
* **Obligations** are the same as for the main photographs: the two CC BY-SA 4.0 files need creator, title,
  link, license and an indication of changes, and the app shows the credit line on each view in the photo panel.
* **Camera geotags.** Paris and New York views use the photographer's `{{Location}}` position and heading
  (*observed*). The Amsterdam series tags the house's address point with a meaningless `heading:N`, so those
  cameras were placed on the facade's outward normal at a stand-off measured from the photo (*inferred*).
* **Privacy.** `gare-de-lyon-south` shows pedestrians; the model labelled two of them `balcony-fence` (false
  positives kept as recorded). No person is detected or identified.
* **Inference.** Real hosted Roboflow inference with `building-facade-segmentation-instance/4`, confidence 0.3,
  on the shipped 2000 px photo: 5 hosted calls in total. Raw responses: `data/raw/<id>/views/<viewId>/roboflow_raw.json`
  and `roboflow_meta.json`. Depth Anything V2 Small ran locally.

## OpenStreetMap (buildings, trees, roads)

* Retrieved via the Overpass API (`overpass-api.de`, with public mirrors as fallback), one query per example,
  radius 220 m (buildings) / 200 m (trees, roads). Query text and retrieval timestamp are stored in each
  `data/raw/<id>/osm.json` under `_sunvision`. Fetch script: `scripts/fetch_osm.py`.
* Subject geocoding: Nominatim (`nominatim.openstreetmap.org`), one request per example, results recorded in
  `data/examples.config.json → targetPointSource`.
* **License:** © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  The ENU-converted footprints, trees and roads in `scene.base.json` are a *Derivative Database*: if you
  publicly use or redistribute them you must attribute OpenStreetMap, keep them under ODbL, and offer the
  derived database (this repository does so). Map tiles shown in the UI carry their own on-map attribution.
* **Usage policy:** for the curated examples we make one Overpass query and one Nominatim lookup per example at
  build time, send a generic `User-Agent`, and never query these services when an example is opened.

## Runtime map data for your own photos (quick upload)

The upload flow runs in the visitor's browser and contacts these public services directly
([research/tiles.md](research/tiles.md)):

| Service | Used for | Data and license | Override |
|---|---|---|---|
| OpenFreeMap vector tiles (`tiles.openfreemap.org`) | the basemap, and building footprints (`building` layer, `render_height`) and streets read from the tiles the map has already loaded | OpenMapTiles schema; data © OpenStreetMap contributors (ODbL). On-map attribution: "OpenFreeMap © OpenMapTiles, Data from OpenStreetMap" | — |
| Photon (`photon.komoot.io`) | address search, tried first | OSM-based geocoder, fair use | `VITE_PHOTON_URL` |
| Nominatim (`nominatim.openstreetmap.org`) | address search fallback; at most 1 request/s, on submit only | [OSMF usage policy](https://operations.osmfoundation.org/policies/nominatim/) | `VITE_GEOCODER_URL` |
| Overpass API | optional trees and streets, merged only if they arrive within 8 s | © OpenStreetMap contributors (ODbL) | `VITE_OVERPASS_URL` |

Tile footprints carry no building type, name, address or levels, and their heights are rounded up. The app
labels them as map data.

## Validation references (never used for reconstruction)

These authoritative heights are stored in `scene.validation` purely to report reconstruction error.
In vision-first mode sunvision-ai ignores them, and ignores the OSM `height` / `building:levels` tags of a
photographed building whenever a photo measures it. A photographed building with no usable measurement falls
back to its OSM tag, and that height is labelled as map data. A building seen *only* in extra views of the
surroundings keeps its explicit OSM `height` tag as an anchor method only when at most one photo method remains,
because those cameras are only roughly placed.

| Example | Dataset | Fields | License |
|---|---|---|---|
| Amsterdam | [3D BAG](https://3dbag.nl) v2 via `api.3dbag.nl` (raw: `data/raw/amsterdam-herengracht/3dbag_pand_items.json`) | `b3_h_dak_max − b3_h_maaiveld`, `b3_h_dak_70p − b3_h_maaiveld` | CC BY 4.0 (3D BAG by tudelft3d / 3DGI) |
| Paris | [IGN BD TOPO v3](https://geoservices.ign.fr/bdtopo) `batiment` via `data.geopf.fr` WFS (raw: `data/raw/paris-boulevard-diderot/ign_bdtopo_batiment.json`) | `hauteur`, `nombre_d_etages` | Licence Ouverte / Etalab 2.0 |
| New York | OSM `height` tag on the target way (originally imported from NYC DoITT building footprints) | `height` | ODbL 1.0 |
| Sarajevo | none: the three OSM ways of the building carry no `height` or `building:levels` | — | — |

Values recorded at build time (heights in metres above ground):

| Example | Target footprint | Reference | Value |
|---|---|---|---|
| Amsterdam | OSM `relation/3581114` (BAG pand 0363100012176861) | 3D BAG `b3_h_dak_max − b3_h_maaiveld` | 22.29 m (ridge); 70th-percentile roof 18.95 m |
| Amsterdam | same | OSM `height` (source: 3DBAG) | 21.3 m |
| Paris | OSM `relation/1211438` | BD TOPO `BATIMENT0000000240741603` `hauteur` / `nombre_d_etages` | 24.5 m / 8 (stated altimetric precision 2.5 m) |
| Paris | same | OSM `building:levels` | 7 |
| New York | OSM `way/278284302` (BIN 1004108) | OSM `height` / `building:levels` | 21.4 m / 5 |
| Sarajevo | OSM `way/191316850` (east wing; `building=apartments`, no address, no levels) | none | — |

Note for Amsterdam: the photo crops the top of the mansard roof, so a photo-derived height measures the
cornice/visible roof; compare against both the ridge (`b3_h_dak_max`) and the 70th-percentile roof height.

NYC Open Data (`data.cityofnewyork.us`) could not be queried directly from the build sandbox (TLS chain
verification failure), so the NYC reference is the OSM-imported value and is labelled as such.

Sarajevo has no open height dataset we could use, and OSM has neither a height nor a storey count for the building,
so there is no reference at all. [VALIDATION.md](VALIDATION.md) reports only a photo-ratio consistency check (≈ 17.5–18.2 m
for the wings with the shipped camera) that uses the same pixels and is therefore not an independent error. OSM tags all three ways
`building=apartments`, while the Commons category files the building as a former police station under government
buildings, so its residential use is an assumption.

## Computer vision model

* **Model:** [`building-facade-segmentation-instance/4`](https://universe.roboflow.com/building-facade/building-facade-segmentation-instance)
  on Roboflow Universe — RF-DETR Instance Segmentation (2XL), classes `car, fence, vegetation, window,
  balcony-fence, facade, non-building-infrastructure, shop, street, traffic-infrastructure`.
* **License:** the dataset/model is published under **CC BY 4.0**; attribute "Building Facade" workspace on
  Roboflow Universe when redistributing its predictions (`analysis.json`).
* Inference provenance (provider, timestamp, latency, threshold) is recorded inside each example's
  `analysis.json → model`.
* For uploads and added views, inference runs on Roboflow's hosted API with the visitor's own key (billed to
  their Roboflow workspace) or the server's capped shared key. The response records which (`privacy.keySource`).
  The key dialog carries the model credit required by CC BY 4.0. See [research/byok.md](research/byok.md).
