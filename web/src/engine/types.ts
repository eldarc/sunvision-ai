/**
 * Geometry contract for the solar / obstruction engine.
 * Pure data, ENU meters (x=east, y=north, z=up). Independent of Three.js so
 * it can run in a Web Worker and in unit tests.
 */
import type { Vec2, Vec3 } from '../schema/scene';

export type ObstacleKind = 'building' | 'target-building' | 'hypothetical' | 'balcony' | 'tree' | 'terrain';

/** Vertical extrusion of a polygon between zMin and zMax. */
export interface PrismObstacle {
  id: string;
  kind: ObstacleKind;
  label: string;
  ring: Vec2[]; // open ring, any winding
  zMin: number;
  zMax: number;
}

/** Oriented box: centre, half extents along its own axes (axes are unit, orthogonal). */
export interface BoxObstacle {
  id: string;
  kind: ObstacleKind;
  label: string;
  center: Vec3;
  axes: [Vec3, Vec3, Vec3];
  halfSize: Vec3;
}

/** Tree: cylinder trunk + spherical crown (crown centre at height - crownRadius). */
export interface TreeObstacle {
  id: string;
  kind: 'tree';
  label: string;
  position: Vec2;
  height: number;
  crownRadius: number;
  trunkRadius: number;
}

export interface ObstacleScene {
  prisms: PrismObstacle[];
  boxes: BoxObstacle[];
  trees: TreeObstacle[];
}

/** Rectangular window on a vertical facade. */
export interface WindowSpec {
  id: string;
  /** Centre of the glazing on the facade plane. */
  center: Vec3;
  /** Outward horizontal unit normal of the facade. */
  normal: Vec3;
  /** Unit vector along the facade (horizontal), right-hand when looking at the facade from outside. */
  uAxis: Vec3;
  width: number;
  height: number;
  /** Id of the obstacle the window belongs to; rays ignore hits on it within `selfEps` of the start. */
  ownerId?: string;
}

export interface SunSample {
  /** UTC epoch ms. */
  t: number;
  azimuth: number; // degrees clockwise from north
  altitude: number; // degrees above horizon
  dir: Vec3; // unit ENU vector pointing TO the sun
}

export interface WindowSampleResult {
  windowId: string;
  /** 0..1 fraction of sample points with an unobstructed line to the sun. */
  litFraction: number;
  /** Sun is above the horizon. */
  daylight: boolean;
  /** Sun is in front of the facade (dot(dir, normal) > 0). */
  facing: boolean;
  /** Obstacle ids that blocked at least one sample point, with counts. */
  blockers: Record<string, number>;
}
