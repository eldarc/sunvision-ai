/**
 * WGS84 geodetic <-> local ENU (East-North-Up) conversion.
 *
 * Exact formulation: geodetic -> ECEF -> rotate into the tangent frame at
 * `origin` (h = 0). The Python fixture builder (scripts/build_scene.py) uses
 * the identical formula so fixtures and browser-side conversions agree.
 */
import type { LatLon, Vec2, Vec3 } from '../schema/scene';

const A = 6378137.0; // WGS84 semi-major axis (m)
const F = 1 / 298.257223563; // flattening
const E2 = F * (2 - F); // first eccentricity squared
const DEG = Math.PI / 180;

export function geodeticToEcef(lat: number, lon: number, h = 0): Vec3 {
  const p = lat * DEG;
  const l = lon * DEG;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const N = A / Math.sqrt(1 - E2 * sp * sp);
  return [(N + h) * cp * Math.cos(l), (N + h) * cp * Math.sin(l), (N * (1 - E2) + h) * sp];
}

export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  // Iterative solution (converges to < 1e-12 rad in a few steps for terrestrial points).
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const sp = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * sp * sp);
    h = p / Math.cos(lat) - N;
    const next = Math.atan2(z, p * (1 - (E2 * N) / (N + h)));
    if (Math.abs(next - lat) < 1e-14) {
      lat = next;
      break;
    }
    lat = next;
  }
  return { lat: lat / DEG, lon: lon / DEG, h };
}

/** Full ENU (including the small negative `up` caused by Earth curvature). */
export function lonLatToEnu3(origin: LatLon, ll: LatLon, h = 0): Vec3 {
  const [x0, y0, z0] = geodeticToEcef(origin.lat, origin.lon, 0);
  const [x, y, z] = geodeticToEcef(ll.lat, ll.lon, h);
  const dx = x - x0;
  const dy = y - y0;
  const dz = z - z0;
  const p = origin.lat * DEG;
  const l = origin.lon * DEG;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sl = Math.sin(l);
  const cl = Math.cos(l);
  return [-sl * dx + cl * dy, -sp * cl * dx - sp * sl * dy + cp * dz, cp * cl * dx + cp * sl * dy + sp * dz];
}

/** Horizontal ENU position (meters east, meters north) of `ll` relative to `origin`. */
export function lonLatToEnu(origin: LatLon, ll: LatLon): Vec2 {
  const e = lonLatToEnu3(origin, ll);
  return [e[0], e[1]];
}

/**
 * Inverse of `lonLatToEnu`. `up` defaults to the curvature drop of the
 * ellipsoid surface so the returned point lies at h ≈ 0.
 */
export function enuToLonLat(origin: LatLon, xy: Vec2 | Vec3): LatLon {
  const e = xy[0];
  const n = xy[1];
  // Point on the ellipsoid ≈ tangent point lowered by d²/(2R).
  const u = xy.length > 2 ? (xy as Vec3)[2] : -(e * e + n * n) / (2 * A);
  const p = origin.lat * DEG;
  const l = origin.lon * DEG;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sl = Math.sin(l);
  const cl = Math.cos(l);
  const dx = -sl * e - sp * cl * n + cp * cl * u;
  const dy = cl * e - sp * sl * n + cp * sl * u;
  const dz = cp * n + sp * u;
  const [x0, y0, z0] = geodeticToEcef(origin.lat, origin.lon, 0);
  const g = ecefToGeodetic(x0 + dx, y0 + dy, z0 + dz);
  return { lat: g.lat, lon: g.lon };
}

/** Compass bearing (deg clockwise from north) of an ENU direction. */
export function bearingOf(dx: number, dy: number): number {
  const b = Math.atan2(dx, dy) / DEG;
  return (b + 360) % 360;
}

/** Unit horizontal ENU vector for a compass bearing. */
export function bearingVector(bearingDeg: number): Vec2 {
  return [Math.sin(bearingDeg * DEG), Math.cos(bearingDeg * DEG)];
}
