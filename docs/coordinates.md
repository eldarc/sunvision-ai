# Coordinate conventions

sunvision-ai uses one shared, metric world frame for map geometry, camera geometry and the solar simulation.
Every component (Python fixture builder, browser reconstruction, solar engine, Three.js renderer) uses the
conventions on this page.

## World frame: local ENU (East-North-Up), meters

| Axis | Meaning |
|------|---------|
| `x`  | east (m) |
| `y`  | north (m) |
| `z`  | up (m), `z = 0` is local ground |

* **Origin** – `Scene.origin` (WGS84 lat/lon, ellipsoidal height `h = 0`). For curated examples it is the
  area centroid of the target building footprint.
* **Ground** – treated as the plane `z = 0` (flat-terrain assumption). Earth curvature inside a 250 m scene is
  < 5 mm and is dropped from horizontal positions (the `u` component of the ENU transform is discarded).
* **Footprint rings** – counter-clockwise in ENU (positive signed area), *open* (first vertex is not repeated).
  Holes are clockwise. For a CCW ring, the outward normal of edge `ring[i] → ring[i+1]` is the edge direction
  rotated −90°: `n = (dy, −dx) / |d|`.
* **Three.js** is y-up. All ENU geometry is rendered inside a group with `rotation.x = −π/2`, which maps
  ENU `(e, n, u)` → three `(e, u, −n)`.

## Geodetic → ENU (exact WGS84)

Constants: `a = 6378137.0`, `f = 1/298.257223563`, `e² = f(2 − f)`.

1. Geodetic → ECEF (for latitude φ, longitude λ, height h):

   ```
   N = a / sqrt(1 − e² sin²φ)
   X = (N + h) cos φ cos λ
   Y = (N + h) cos φ sin λ
   Z = (N (1 − e²) + h) sin φ
   ```

2. ECEF → ENU at origin (φ₀, λ₀, h₀ = 0) with ECEF origin `O`, `d = P − O`:

   ```
   e = −sin λ₀ · dX + cos λ₀ · dY
   n = −sin φ₀ cos λ₀ · dX − sin φ₀ sin λ₀ · dY + cos φ₀ · dZ
   u =  cos φ₀ cos λ₀ · dX + cos φ₀ sin λ₀ · dY + sin φ₀ · dZ
   ```

3. Inverse: ENU → ECEF (transpose of the rotation) → geodetic by fixed-point iteration on latitude
   (`φ ← atan2(Z, p (1 − e² N/(N + h)))`, `p = sqrt(X² + Y²)`), converging in < 5 iterations.

Reference implementation: `scripts/build_scene.py` (`ENU` class). The browser implementation lives in
`web/src/engine/geo.ts` and must reproduce the check value below.

### Numeric check value

Origin `(52.0°, 5.0°, h=0)`; point `(52.001°, 5.001°, h=0)`:

```
e =  68.6765 m
n = 111.2678 m
u =  -0.0013 m
```

(Round-trip back to lat/lon reproduces the input to better than 1e-9°.)

## Angles

| Quantity | Convention |
|----------|------------|
| Compass heading / azimuth | degrees, clockwise from **north** (0 = N, 90 = E, 180 = S, 270 = W) |
| Sun azimuth | same as above. SunCalc ≥ 2.0 returns degrees clockwise from north (SunCalc 1.x used radians from south — do not mix) |
| Sun altitude | degrees above the horizon |
| Camera pitch | degrees above the horizon (+ = looking up) |
| Camera roll | degrees, + = clockwise image rotation |
| `hfov` | horizontal field of view of the full image width, degrees |

Unit vector pointing to the sun in ENU (azimuth `A`, altitude `α`):

```
dir = ( sin A · cos α,  cos A · cos α,  sin α )
```

A compass bearing `β` as a horizontal ENU vector is `(sin β, cos β, 0)`; the bearing of a vector `(x, y)` is
`atan2(x, y)` (in degrees, wrapped to [0, 360)).

## Image space

Pixel coordinates have their origin at the **top-left**, `x` to the right and `y` down, in the resolution
of `Scene.image.width × height` (the resized `photo.jpg` that ships with each example — *not* the Commons
original). Detections, polygons, rooflines and floor rows all use this space.

### 35 mm-equivalent focal length → hfov

EXIF `FocalLengthIn35mmFilm` follows the diagonal convention (the 43.27 mm diagonal of a 36 × 24 mm frame).
For an image of `w × h` pixels the equivalent horizontal sensor size is `43.27 · w / sqrt(w² + h²)` mm and

```
hfov = 2 · atan( (43.27 · w / sqrt(w² + h²)) / (2 · f35) )
```

This is only valid for uncropped frames; cropped images (e.g. the square NYC example) need calibration.

## Time

Simulation timestamps are UTC epoch milliseconds. Local clock time is interpreted in `Scene.timezone`
(IANA, e.g. `Europe/Amsterdam`) including daylight-saving transitions.
