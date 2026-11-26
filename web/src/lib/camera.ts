/**
 * Pinhole camera model in the shared ENU frame.
 *
 * heading: compass degrees of the optical axis (clockwise from north)
 * pitch:   degrees above horizon (+ up)
 * roll:    degrees, + rotates the image clockwise
 * hfov:    horizontal field of view (degrees)
 * Pixels: origin top-left, x right, y down, principal point at image centre.
 */
import type { CameraParams, Vec2, Vec3 } from '../schema/scene';

const D2R = Math.PI / 180;

export interface CameraBasis {
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  focalPx: number;
  width: number;
  height: number;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function focalFromHfov(width: number, hfovDeg: number) {
  return width / 2 / Math.tan((hfovDeg * D2R) / 2);
}

export function cameraBasis(cam: CameraParams, width: number, height: number): CameraBasis {
  const h = cam.heading * D2R;
  const p = cam.pitch * D2R;
  const r = cam.roll * D2R;
  const forward: Vec3 = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right0: Vec3 = [Math.cos(h), -Math.sin(h), 0];
  const up0 = cross(right0, forward);
  // roll: rotate right/up around forward. + roll = image rotated clockwise, i.e. camera rolled counter-clockwise.
  const c = Math.cos(r);
  const s = Math.sin(r);
  const right = norm(add(scale(right0, c), scale(up0, -s)));
  const up = norm(add(scale(right0, s), scale(up0, c)));
  return {
    eye: [cam.position[0], cam.position[1], cam.height],
    forward,
    right,
    up,
    focalPx: focalFromHfov(width, cam.hfov),
    width,
    height,
  };
}

/** World-space unit ray direction through image pixel (px, py). */
export function pixelToRay(b: CameraBasis, px: number, py: number): Vec3 {
  const xc = (px - b.width / 2) / b.focalPx;
  const yc = (b.height / 2 - py) / b.focalPx;
  return norm(add(add(b.forward, scale(b.right, xc)), scale(b.up, yc)));
}

/** Project a world point to pixels. Returns null if behind the camera. */
export function worldToPixel(b: CameraBasis, p: Vec3): Vec2 | null {
  const d = sub(p, b.eye);
  const z = dot(d, b.forward);
  if (z <= 1e-6) return null;
  const x = dot(d, b.right) / z;
  const y = dot(d, b.up) / z;
  return [b.width / 2 + x * b.focalPx, b.height / 2 - y * b.focalPx];
}

export interface FacadePlane {
  buildingId: string;
  edgeIndex: number;
  a: Vec2; // edge start
  b: Vec2; // edge end
  normal: Vec3; // outward horizontal normal
  length: number;
}

/** Outward normal of edge (a→b) of a CCW ring is the edge direction rotated -90°. */
export function edgeOutwardNormal(a: Vec2, b: Vec2, ccw = true): Vec3 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return ccw ? [dy / l, -dx / l, 0] : [-dy / l, dx / l, 0];
}

export function ringIsCCW(ring: Vec2[]) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s > 0;
}

export function facadePlane(buildingId: string, ring: Vec2[], edgeIndex: number): FacadePlane {
  const a = ring[edgeIndex % ring.length];
  const b = ring[(edgeIndex + 1) % ring.length];
  return {
    buildingId,
    edgeIndex,
    a,
    b,
    normal: edgeOutwardNormal(a, b, ringIsCCW(ring)),
    length: Math.hypot(b[0] - a[0], b[1] - a[1]),
  };
}

export interface PlaneHit {
  t: number; // distance along the ray (m)
  u: number; // distance along the edge from a (m)
  z: number; // height above ground (m)
  point: Vec3;
}

/**
 * Intersect a ray with the vertical plane through a footprint edge.
 * `clampToEdge=false` allows hits slightly beyond the edge (useful for rooflines near corners).
 */
export function intersectFacade(eye: Vec3, dir: Vec3, f: FacadePlane, margin = 0): PlaneHit | null {
  const n = f.normal;
  const denom = dot(dir, n);
  if (Math.abs(denom) < 1e-9) return null;
  const pa: Vec3 = [f.a[0], f.a[1], 0];
  const t = dot(sub(pa, eye), n) / denom;
  if (t <= 0) return null;
  const point = add(eye, scale(dir, t));
  const ex = (f.b[0] - f.a[0]) / f.length;
  const ey = (f.b[1] - f.a[1]) / f.length;
  const u = (point[0] - f.a[0]) * ex + (point[1] - f.a[1]) * ey;
  if (u < -margin || u > f.length + margin) return null;
  return { t, u, z: point[2], point };
}

/** Intersect a ray with the ground plane z = 0. */
export function intersectGround(eye: Vec3, dir: Vec3): Vec3 | null {
  if (dir[2] >= -1e-9) return null;
  const t = -eye[2] / dir[2];
  return add(eye, scale(dir, t));
}

/** Horizontal distance from camera ground point to the facade plane (m). */
export function distanceToFacade(cam: CameraParams, f: FacadePlane) {
  const n = f.normal;
  return Math.abs((cam.position[0] - f.a[0]) * n[0] + (cam.position[1] - f.a[1]) * n[1]);
}
