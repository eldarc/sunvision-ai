# Solar simulation

Code: [`web/src/engine/`](../web/src/engine). It is pure TypeScript with no Three.js dependency, so it runs in a Web Worker and in node tests (30 tests in `engine/__tests__`).

## Sun position

* **SunCalc 2.x** (`suncalc@2.1.4`). The 2.x API returns **azimuth in degrees clockwise from north** and altitude in degrees, with a refraction correction. SunCalc 1.x used radians measured from the south, so a test locks this convention. An independent NOAA implementation in the tests agrees to within 0.3° (azimuth) and 0.35° (altitude) across 6 city/date cases.
* ENU sun vector: `east = sin(az)·cos(alt)`, `north = cos(az)·cos(alt)`, `up = sin(alt)`.
* **Time zones.** Wall-clock times are converted with Luxon in the scene's IANA zone (`Europe/Amsterdam`, `Europe/Paris`, `America/New_York`). DST days have 23 or 25 hours, and the tests cover both transitions in Amsterdam and New York. Uploaded photos get their zone from `tz-lookup`.

## Obstruction (exact ray casting)

`buildObstacleIndex` puts every obstacle into a uniform 8 m XY grid, and rays walk the grid cells. Intersections are exact:

* **Prisms** (building footprints, including concave ones; hypothetical towers): the side walls are 2D segment intersections checked against the z-range, and the caps are point-in-polygon tests.
* **Oriented boxes** (balconies, overhangs): slab method in the box frame.
* **Trees:** a sphere for the crown plus a cylinder for the trunk.

A ray starts 2 cm in front of the window, and hits on the window's own building closer than 5 cm are ignored.

## Exposure

For each window, a 4 × 3 grid of sample points covers the glazing.

1. **Night:** if the sun's altitude is ≤ 0, the lit fraction is 0.
2. **Facing away:** if `dir · normal ≤ 0`, the lit fraction is 0.
3. **Otherwise:** a ray is cast from each point toward the sun. The **lit fraction** is the share of points that reach the sun unobstructed, and the obstacle hit by each blocked ray is tallied as a blocker.

**Daily** (5-minute bins, wall-clock):

* lit-fraction-weighted direct minutes
* morning vs afternoon, split at solar noon
* first and last direct sun
* intervals with more than 50 % of the window lit, and intervals with any light
* share of daylight with direct sun
* window-minutes removed by each blocker

An apartment's result is the mean across its windows.

**Annual** (Web Worker, cached by an FNV-1a hash of the inputs): every 7th day × 15-minute bins → a heatmap, plus monthly averages, per-window means and the solstice/equinox summaries. The resolution is disclosed in the UI. A typical run (6 windows × 53 days × 96 bins × 12 rays, 400 buildings) takes about 0.1 s in node.

## Physical checks (automated)

* A south window at 52° N is lit at the June noon.
* A north window is unlit at the winter noon, and night gives zero.
* A tall block in front blocks the sun and is reported as the blocker.
* **Monotonicity:** raising an obstacle never increases the direct minutes (10 heights × 3 dates).
* Raising the window above the obstruction increases its exposure.
* A tree blocks the sun.
* A balcony overhang reduces summer-noon exposure for the window below.
* An east window gets its sun in the morning.
* At 52° N the annual matrix shows December < June.
* **Integration:** a hypothetical tower across the street reduces the apartment's direct sun, and a balcony set in the inspector reduces summer exposure (`reconstruct.test.ts`).

## What it is (and isn't)

These are **potential direct sunlight** estimates under a clear sky on the modelled geometry. There is no diffuse sky light, no reflections, no weather, no glazing transmittance and no interior illuminance. Results are as good as the reconstructed geometry. Use the *low / best / high* scenarios to see how much that matters.
