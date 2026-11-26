/**
 * Pure helpers for the manual upload wizard (components/UploadWizard.tsx, #/upload/manual).
 *
 * The wizard reads building footprints from the basemap's vector tiles (lib/tiles.ts
 * `loadFootprintsFromMap`), exactly like the quick upload's BuildingPicker, so picking a
 * building never waits on the public Overpass API. A "frame" is one such read: footprints and
 * streets in ENU metres around `origin`. These helpers pick the footprint under a click, keep
 * the selected building across reloads (map moved, camera dragged, theme switched), merge an
 * on-demand read into the frame, and turn the user's camera into a `CameraPlacement` for
 * lib/tileBuildings.ts `buildTileScene`.
 *
 * Everything here is pure (no MapLibre, no React) and unit-tested in
 * components/__tests__/wizardFrame.test.ts.
 */
import type { Feature, FeatureCollection } from 'geojson';
import type { Footprint, LatLon, Vec2 } from '../../../schema/scene';
import { enuToLonLat, lonLatToEnu } from '../../../engine/geo';
import { pointInRing } from '../../../lib/sceneBuilder';
import { ringArea, type Street } from '../../../lib/tiles';
import { footprintToLngLat, reprojectFootprints, ringCentroid, type CameraPlacement } from '../../../lib/tileBuildings';

/** One read of footprints (and streets) from the map tiles, in ENU metres around `origin`. */
export interface WizardFrame {
  origin: LatLon;
  footprints: Footprint[];
  streets: Street[];
  warnings: string[];
}

/** Overpass enrichment budget (ms), as in the quick upload's build step. */
export const OVERPASS_BUDGET_MS = 8000;
/** Radius (m) read around a click that hit nothing in the current frame. */
export const PICK_RADIUS = 60;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance (m) from p to a ring's outline. */
function distToRing(p: Vec2, ring: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

/** True when p lies on the footprint's area (inside the outer ring, outside every hole). */
export function insideFootprint(p: Vec2, fp: Pick<Footprint, 'ring' | 'holes'>): boolean {
  return pointInRing(p, fp.ring) && !(fp.holes ?? []).some((h) => pointInRing(p, h));
}

/**
 * Id of the footprint under `ll` (nested footprints: the smallest one). With `toleranceM` > 0, a
 * click just outside an outline (on the drawn line, within that many metres) still counts; the
 * nearest outline wins. Null when there is no building there.
 */
export function footprintAt(frame: Pick<WizardFrame, 'origin' | 'footprints'>, ll: LatLon, toleranceM = 0): string | null {
  const p = lonLatToEnu(frame.origin, ll);
  let best: { id: string; area: number } | null = null;
  for (const f of frame.footprints) {
    if (f.ring.length < 3 || !insideFootprint(p, f)) continue;
    const a = Math.abs(ringArea(f.ring));
    if (!best || a < best.area) best = { id: f.id, area: a };
  }
  if (best) return best.id;
  if (!(toleranceM > 0)) return null;
  let near: { id: string; d: number } | null = null;
  for (const f of frame.footprints) {
    if (f.ring.length < 3) continue;
    const d = distToRing(p, f.ring);
    if (d <= toleranceM && (!near || d < near.d)) near = { id: f.id, d };
  }
  return near?.id ?? null;
}

/** Ground resolution (m per CSS pixel) of a web-mercator map at `zoom` and latitude `lat` (512 px tiles). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

/** Drop `next` footprints that sit on `fp` (centroid inside one another): fp replaces them. */
function withoutOverlaps(fps: Footprint[], fp: Footprint): Footprint[] {
  const c = ringCentroid(fp.ring);
  return fps.filter((f) => f.id !== fp.id && !pointInRing(ringCentroid(f.ring), fp.ring) && !pointInRing(c, f.ring));
}

/**
 * Keep the selected building when the frame is re-read (map moved, camera dragged, theme switch).
 *  - same id in the new read → kept;
 *  - a tile footprint whose id changed (tile pieces merged differently) → the new footprint that
 *    contains the old centroid with a similar area (0.5×–2×);
 *  - otherwise (a drawn outline, or the building scrolled out of the read) the old footprint is
 *    carried into the new frame, replacing whatever overlaps it.
 * Returns the frame to use and the target id in it (null when there was no target).
 */
export function carryTarget(prev: WizardFrame | null, targetId: string | null, next: WizardFrame): { frame: WizardFrame; targetId: string | null } {
  if (!targetId) return { frame: next, targetId: null };
  if (next.footprints.some((f) => f.id === targetId)) return { frame: next, targetId };
  const old = prev?.footprints.find((f) => f.id === targetId);
  if (!prev || !old) return { frame: next, targetId: null };
  const here = reprojectFootprints([old], prev.origin, next.origin)[0];
  if (here.source !== 'user') {
    const c = ringCentroid(here.ring);
    const a = Math.abs(ringArea(here.ring));
    const match = next.footprints.find((f) => {
      const fa = Math.abs(ringArea(f.ring));
      return insideFootprint(c, f) && fa > a * 0.5 && fa < a * 2;
    });
    if (match) return { frame: next, targetId: match.id };
  }
  return { frame: { ...next, footprints: [here, ...withoutOverlaps(next.footprints, here)] }, targetId };
}

/**
 * Merge an on-demand read (`add`, e.g. around a click) into `base`, in base's ENU frame. Footprints
 * already in base (same id, or centroid inside a base footprint) are skipped, except `keepId`,
 * which is always included and replaces what overlaps it. Without a base, `add` is returned.
 */
export function mergeFrames(base: WizardFrame | null, add: WizardFrame, keepId?: string | null): WizardFrame {
  if (!base) return add;
  const moved = reprojectFootprints(add.footprints, add.origin, base.origin);
  const keep = keepId ? moved.find((f) => f.id === keepId) : undefined;
  let fps = keep ? [keep, ...withoutOverlaps(base.footprints, keep)] : [...base.footprints];
  for (const f of moved) {
    if (f === keep || fps.some((g) => g.id === f.id)) continue;
    const c = ringCentroid(f.ring);
    if (fps.some((g) => pointInRing(c, g.ring))) continue;
    fps = [...fps, f];
  }
  const streetIds = new Set(base.streets.map((s) => s.id));
  const streets = [
    ...base.streets,
    ...add.streets.filter((s) => !streetIds.has(s.id)).map((s) => ({ ...s, line: s.line.map((p) => lonLatToEnu(base.origin, enuToLonLat(add.origin, p))) })),
  ];
  return { origin: base.origin, footprints: fps, streets, warnings: base.warnings };
}

/** GeoJSON for the map: every footprint with properties { id, sel }; malformed rings are skipped. */
export function frameFeatures(frame: Pick<WizardFrame, 'origin' | 'footprints'> | null, targetId: string | null): FeatureCollection {
  if (!frame) return { type: 'FeatureCollection', features: [] };
  const ok = (r: [number, number][]) => r.length >= 4 && r.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const features: Feature[] = [];
  for (const f of frame.footprints) {
    if (f.ring.length < 3) continue;
    const outer = footprintToLngLat(f, frame.origin);
    if (!ok(outer)) continue;
    const holes = (f.holes ?? []).map((h) => footprintToLngLat({ ring: h }, frame.origin)).filter(ok);
    features.push({ type: 'Feature', properties: { id: f.id, sel: f.id === targetId }, geometry: { type: 'Polygon', coordinates: [outer, ...holes] } });
  }
  return { type: 'FeatureCollection', features };
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export interface WizardCameraInput {
  /** Camera ground position (EXIF GPS or the dot placed on the map). */
  camera: LatLon;
  /** Viewing direction (deg clockwise from north). */
  heading: number;
  positionProv: 'observed' | 'manual';
  headingProv: 'observed' | 'manual';
  /** EXIF GPSImgDirectionRef: 'M' = magnetic north. */
  headingRef?: string;
}

/**
 * The wizard's camera as a `CameraPlacement` in the ENU frame of `frameOrigin`. Position and
 * heading keep the provenance the user gave them: 'observed' (EXIF) or 'manual' (placed / clicked
 * on the map). The scene's auto-alignment never moves 'manual' parameters.
 */
export function wizardCamera(frameOrigin: LatLon, inp: WizardCameraInput): CameraPlacement {
  const heading = ((inp.heading % 360) + 360) % 360;
  const notes = [
    inp.positionProv === 'observed' ? 'Camera position from the photo’s EXIF GPS.' : 'Camera position placed by you on the map.',
    inp.headingProv === 'observed'
      ? `Viewing direction ${heading.toFixed(0)}° from EXIF${inp.headingRef === 'M' ? ' (magnetic north, not corrected for declination)' : ''}.`
      : `Viewing direction ${heading.toFixed(0)}° set by you on the map (towards the point you clicked).`,
  ];
  return {
    position: lonLatToEnu(frameOrigin, inp.camera),
    heading,
    provenance: { position: inp.positionProv, heading: inp.headingProv },
    basis: inp.positionProv === 'observed' ? 'gps' : 'manual',
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Time box                                                            */
/* ------------------------------------------------------------------ */

/** Resolve with `{ value }` when `p` settles within `ms`, or null on timeout or rejection. */
export function timeBoxed<T>(p: Promise<T>, ms: number): Promise<{ value: T } | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (value) => {
        clearTimeout(t);
        resolve({ value });
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}
