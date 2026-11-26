# Limitations and future work

## Known limitations

**Camera calibration**
* Heights depend on the camera. Geotags can be metres off, compass headings tens of degrees off, and cropped photos have unknown intrinsics. The app solves the pitch from the ground line and auto-aligns pitch, roll, FOV, heading and position from the window grid. That needs a visible, reasonably regular window grid. It never moves a parameter you set by hand (*manual*), and it refuses changes that are not clearly better, so a bad starting camera can survive. *Check the fit* (corner resection) is the fallback, and a wrong corner pick produces a confidently wrong camera: the hand-picked NYC resection contains one ([VALIDATION.md](VALIDATION.md)).
* The ground line can sit on awnings, canopies or signs. `plausibleGroundline` drops samples with a window below them, but Paris's ground line still lies mostly on café awnings, which probably biases its pitch low ([research/alignment.md](research/alignment.md) §5). A true street-contact cue (street mask edge, pedestrians' feet, an awning class) is missing.
* When a photo has no focal length, the FOV and hence the whole metric scale rest on an assumed 3.3 m storey. The note says so, and heights inherit about ±15 %. Canal houses (4.14 m measured in Amsterdam) or modern offices break this assumption.
* The NYC solution sits at the lower bound of its EXIF FOV range. Unconstrained, regularity prefers a FOV that is impossible for the crop, which points at model error elsewhere (no corner chamfer in OSM, edge positions, facade bulge).
* Auto-alignment costs 60–190 ms per photo in node ([research/alignment.md](research/alignment.md) §2.3), and it runs for every photo on load.

**Reconstruction**
* Vision measures the top of the visible facade. Roofs (gables, mansards, dormers) are not reconstructed, so every building is a flat-roofed extrusion.
* Fusion weights and plausible ranges are heuristic. They are not calibrated confidence intervals; we have three validation buildings, not a benchmark.
* A building is raised to clear its highest detected window. That is right for dormers (part of the roof volume for shading), but a misplaced window can also inflate a height. A warning names the building each time.
* A building far behind the target that the facade mask swallows is set aside by depth (roofline samples and windows at least 2× farther than the facade they project onto, read from the uncalibrated relative depth map). That needs a depth map and at least 3 windows as a reference. A building just behind (less than 2× the facade's distance), a background that covers almost the whole roofline, or one that the depth model blurs into sky is not caught, and the windows set aside are dropped rather than placed on the building behind. The threshold is tuned on four photos (the Amsterdam, Paris and New York examples and the Vilsonovo regression fixture) and their extra views; on mixed roof-and-background stretches (ratios 0.5–0.6) it keeps the samples.
* Monocular depth (method C) is often unavailable or rejected. It needs enough visible street with known geometry, and canals, parked cars and crowds break the ground-plane assumption. NYC's depth could not be calibrated at all.
* Balcony depth is assumed (1.0 m), because protrusion isn't observable from a frontal photo.
* Floor assignment assumes a regular floor height, with a configurable taller ground floor. Window regularisation snaps to the storey grid by at most 0.6 m, so an irregular facade (split levels, stair windows) keeps some raw positions.
* Window boxes are axis-aligned around perspective trapezoids, so sizes are slightly overestimated on oblique views (≈0.1 m in the tests).
* Stepped OSM footprints (Amsterdam's stoop edge) are extruded to full height, and windows can land on them.
* OSM footprints can be offset by about 1–3 m, and details such as chamfered corners and stoops may be missing or extra.

**Oblique street photos**
* An oblique photo's scale comes from the camera's distance to the facade, taken from the map (opposite street wall minus an assumed 3 m pavement, or twice the distance to the street centre line), with the lens height assumed at 1.6 m. Expect roughly ±15–20 % in heights; the photo itself does not check this distance unless a ground line is detected.
* The field of view is not inferred from storey spacing for oblique photos. Without EXIF it stays at the assumed 60° (refined only by facade regularity), so a vanishing point far outside the frame can leave the heading several degrees off (the notes say so).
* In a terrace whose windows continue across neighbouring buildings, the position along the street is a guess; the notes say so and the camera dot can be dragged.
* For oblique photos the main-street facade is preferred when no side was chosen. A photo taken along a lane with a main road behind the building needs the side chip.
* The camera model has no principal-point offset, so cropped or perspective-corrected photos are approximated with pitch.

**Multi-view**
* Extra views are calibrated independently. There is no joint term that makes two photos of the same building agree on its storey grid.
* A building seen only in extra views and measured by at most one photo method keeps its explicit OSM height tag as an anchor, so its "photo" height is then partly map data. The method list shows this.
* Extra-view measurements whose window rows contradict the camera scale are set aside (one case in the fixtures: Amsterdam's `across-canal-261`). The NYC view of PS 140 contributes only a weak floors × floor-height measurement under an assumed FOV, fused with the OSM tag: the model finds no facade behind the leafless trees, so there is no roofline.
* Only buildings that some photo sees get photo-based heights. Others rely on OSM tags or an assumed scene median, as labelled in the UI.

**Simulation**
* Direct beam only, under a clear sky. There is no diffuse sky light, no reflections, no weather, no glazing transmittance and no indoor illuminance.
* The terrain is flat. Hills and the curvature of the horizon are ignored.
* Trees are opaque spheres all year (no leaf-off season, no porosity). The season chips change the date, not the trees.
* Window frames, reveals and interior depth of the glazing are not modelled.
* The sampling resolution is disclosed in the UI: 5-minute daily bins, 15-minute bins and every 7th day for the annual view, 12 rays per window.

**Uploads and keys**
* Photo analysis needs the sunvision-ai API. Roboflow serverless does not allow browser origins outside `*.roboflow.com`, so the browser cannot call it directly, even with the visitor's own key.
* The shared key is capped per month and per client per day. When it runs out, visitors need their own Roboflow key. The free Roboflow plan's credits are per workspace and shared with anything else the workspace does.
* Map-tile footprints carry no building type, name, address or levels, heights are rounded up (about 0.5 m), buildings are cut at the edge of the loaded tiles, and footprint ids change when OSM edits the geometry ([research/tiles.md](research/tiles.md) §9).
* The automatic camera stands across the nearest street centre line and ignores water and private ground. In canal cities it can land on the quay edge or in the water; drag it.
* Geocoding and the optional tree and street enrichment depend on public Photon, Nominatim and Overpass servers.
* Interiors are hypothetical volumes, not floor plans.
* The *required* key dialog opens before a request only when `/api/health` says the shared key is disabled, used up or absent. If the health check has not answered yet, or the last free slots are only reserved by requests in flight, the upload sends the request anyway and asks for a key when the API refuses it (402/429).
* The direction picker offers up to 12 sides of the picked footprint, merged from nearly collinear tile edges; a short side can be dropped, and the camera's distance from the chosen side (15 m by default) is a guess labelled *assumed* until you drag the dot or the photo's GPS position is in front of that side.
* There are no accounts, no persistence of edits beyond the session, and no sharing yet. The only deep links are `#/example/<id>` for the curated examples, and `#/upload` (`#/upload/manual` for the manual wizard); an uploaded scene cannot be linked.

**Phones and crash handling**
* On phones and tablets narrower than 1024 px the 3D view sits in a scrolling column, so one finger scrolls the page and orbiting and zooming need two fingers. On wider touch screens (large tablets) one-finger drags on the 3D view orbit it, so the page cannot be scrolled by dragging over the 3D view.
* Error boundaries contain errors thrown while rendering. As in any React app, errors in event handlers, timers, promises or the annual Web Worker do not reach them. After a lost WebGL context the 3D view is rebuilt from the current state, not resumed.

## Roadmap

1. **A real street contact for the ground line** (lower edge of the `street` mask, pedestrians' feet, or an awning class), to remove the Paris pitch bias.
2. **Joint multi-view alignment:** one storey grid per building shared by every photo that sees it, constraining all cameras together.
3. **Roof reconstruction** from the roofline profile and the RF-DETR roof/dormer classes of a dedicated model, adding gable, mansard and hip primitives.
4. **Depth Anything 3** via Roboflow `inference-models` (metric variants), with automatic comparison against V2.
5. **Terrain** from open DEMs (Copernicus GLO-30, AHN, LiDAR HD) for hillside cities, plus **far-horizon** obstruction.
6. **Seasonal vegetation** (leaf-on/off porosity) and species height priors.
7. **Shareable sunlight reports**, GLB export of the twin, and a reusable Supervision.js example for image-to-3D annotation projection.
8. **Sign in with Roboflow** (OAuth) as a smoother alternative to pasting a key, once its tokens work for inference ([research/byok.md](research/byok.md)).
9. **Benchmark:** a few hundred Commons photos in Dutch cities against the 3D BAG, to calibrate the fusion weights and report real error distributions.
