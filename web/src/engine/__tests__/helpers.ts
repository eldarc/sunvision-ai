import type { ObstacleScene, PrismObstacle, WindowSpec } from '../types';
import type { Vec2 } from '../../schema/scene';

export const AMS = { lat: 52.3731, lon: 4.8926, tz: 'Europe/Amsterdam' };

export function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Target building occupying y ∈ [0, 10] with its south facade on y = 0. */
export function target(height = 20): PrismObstacle {
  return { id: 'target', kind: 'target-building', label: 'Target', ring: rect(-10, 0, 10, 10), zMin: 0, zMax: height };
}

export function southWindow(z = 5, id = 'w-south'): WindowSpec {
  return { id, center: [0, 0, z], normal: [0, -1, 0], uAxis: [1, 0, 0], width: 1.2, height: 1.6, ownerId: 'target' };
}

/** Same building, window on the north facade (y = 10). */
export function northWindow(z = 5): WindowSpec {
  return { id: 'w-north', center: [0, 10, z], normal: [0, 1, 0], uAxis: [-1, 0, 0], width: 1.2, height: 1.6, ownerId: 'target' };
}

/** A wide slab building south of the target, across a 12 m street. */
export function southObstacle(height: number): PrismObstacle {
  return { id: 'opposite', kind: 'building', label: 'Opposite block', ring: rect(-60, -22, 60, -12), zMin: 0, zMax: height };
}

export function scene(prisms: PrismObstacle[], extra: Partial<ObstacleScene> = {}): ObstacleScene {
  return { prisms, boxes: extra.boxes ?? [], trees: extra.trees ?? [] };
}

/** Independent NOAA solar position (no refraction), for cross-checking SunCalc. */
export function noaaSun(date: Date, lat: number, lon: number): { azimuth: number; altitude: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C =
    Math.sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * M * rad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(appLong * rad)) / rad;
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    4 *
    (y * Math.sin(2 * L0 * rad) -
      2 * e * Math.sin(M * rad) +
      4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) -
      0.5 * y * y * Math.sin(4 * L0 * rad) -
      1.25 * e * e * Math.sin(2 * M * rad)) /
    rad;
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (((minutesUtc + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const zen = Math.acos(Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad)) / rad;
  let az = Math.acos(((Math.sin(lat * rad) * Math.cos(zen * rad)) - Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.sin(zen * rad))) / rad;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { azimuth: az, altitude: 90 - zen };
}
