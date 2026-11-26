/**
 * Scenes from map-tile footprints (upload flow).
 *
 * The quick upload flow never waits on Overpass. Footprints come from the basemap's
 * vector tiles (lib/tiles.ts, ids 'omt/<lat>,<lon>') or from a footprint the user
 * draws ('user/…'). This module turns them into a `Scene` with the same semantics as
 * lib/sceneBuilder.ts `buildScene`:
 *
 *  - the ENU origin is the target footprint's centroid, at street level;
 *  - `facadeEdgeIndex` is the target edge the camera looks at;
 *  - `visibleBuildingIds` are other buildings hit by rays across the field of view;
 *  - every camera field carries its provenance (GPS = observed, auto placement = assumed,
 *    dragged = manual, aimed at the building = inferred);
 *  - the timezone comes from tz-lookup.
 *
 * Optional Overpass enrichment (OSM ids, exact height tags, trees, roads) is merged in
 * when it arrived in time; nothing here fetches anything. Nothing is fabricated: without
 * an analysis the detections are empty and the user marks windows by hand.
 *
 * Everything here is pure and unit-tested (lib/__tests__/tileBuildings.test.ts).
 */
import tzlookup from 'tz-lookup';
import type { CameraParams, FacadeAnalysis, Footprint, ImageInfo, LatLon, Provenance, Scene, Tree, Vec2 } from '../schema/scene';
import { bearingOf, enuToLonLat, lonLatToEnu } from '../engine/geo';
import { ringIsCCW } from './camera';
import { facingEdge, firstHit, pointInRing, ringFromGeometry, elementOuter } from './sceneBuilder';
import { parseHeight, type OsmElement } from './osm';
import { autoCameraForBuilding, ringArea, unionRings, type Street } from './tiles';
import { calibratePitch } from './reconstruct';
import { autoAlignCamera } from './align';
import { obliqueStart } from './vanishing';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Horizontal FOV used when the photo has no 35 mm-equivalent focal length (assumed). */
export const ASSUMED_HFOV = 60;
/** Default lens height of a hand-held street photo (assumed). */
export const ASSUMED_LENS_HEIGHT = 1.6;
/** Default pitch before it is solved from the detected ground line (assumed). */
export const ASSUMED_PITCH = 8;
/** Without GPS the camera stands this far out from the street-facing facade. */
export const AUTO_CAMERA_DISTANCE = 15;
/** Diagonal of a 35 mm frame (mm); the "35 mm equivalent" focal length is defined against it. */
const FULL_FRAME_DIAGONAL = 43.27;

/* ------------------------------------------------------------------ */
/* Field of view from EXIF                                             */
/* ------------------------------------------------------------------ */

/**
 * Horizontal FOV (deg) from the EXIF 35 mm-equivalent focal length, using the diagonal
 * convention (43.27 mm): for a 3:2 landscape frame this equals 2·atan(36 / 2f); for other
 * aspect ratios (4:3, portrait) the horizontal share of the diagonal is used.
 */
export function hfovFromFocal35(focal35: number, width: number, height: number): number {
  const diag = Math.hypot(width, height) || 1;
  const halfW = (FULL_FRAME_DIAGONAL * (width / diag)) / 2;
  return (2 * Math.atan(halfW / focal35) * 180) / Math.PI;
}

/**
 * Plausible FOV bounds for an EXIF-derived FOV: a crop narrows the FOV, nothing widens it
 * (docs/research/alignment.md §4.2: [0.5, 1.05] × hfov).
 */
export function hfovRangeFromExif(hfov: number): [number, number] {
  return [Math.max(5, hfov * 0.5), Math.min(150, hfov * 1.05)];
}

/** The camera's FOV, its provenance, the alignment bounds and a note, from EXIF (or assumed). */
export function fovFromExif(exif: ImageInfo['exif'] | undefined, width: number, height: number): { hfov: number; provenance: Provenance; range?: [number, number]; note: string } {
  const f35 = exif?.focalLength35mm;
  if (f35 && f35 > 4 && f35 < 2000) {
    const hfov = hfovFromFocal35(f35, width, height);
    return { hfov, provenance: 'observed', range: hfovRangeFromExif(hfov), note: `Field of view ${hfov.toFixed(1)}° from the EXIF 35 mm-equivalent focal length (${f35} mm); a crop could make it narrower.` };
  }
  return { hfov: ASSUMED_HFOV, provenance: 'assumed', note: `Field of view assumed (${ASSUMED_HFOV}°): no 35 mm-equivalent focal length in the photo's metadata.` };
}

/* ------------------------------------------------------------------ */
/* Location input: coordinates and map links, parsed locally           */
/* ------------------------------------------------------------------ */

export interface ParsedLocation extends LatLon {
  zoom?: number;
  kind: 'coordinates' | 'google' | 'osm' | 'apple' | 'geo-uri' | 'link';
}

const NUM = '[-+]?\\d{1,3}(?:\\.\\d+)?';
const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function pair(s: string | null | undefined): LatLon | null {
  if (!s) return null;
  const m = s.trim().match(new RegExp(`^(${NUM})\\s*,\\s*(${NUM})`));
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return valid(lat, lon) ? { lat, lon } : null;
}

/** True when the text looks like a URL (so it should not be sent to a geocoder). */
export function looksLikeLink(text: string): boolean {
  return /^\s*(?:https?:\/\/|www\.|geo:|maps\.|goo\.gl\/|maps\.app\.goo\.gl\/)/i.test(text);
}

/**
 * Parse "lat, lon" (also "lat lon", "lat; lon", degree signs and N/S/E/W suffixes), Google,
 * OpenStreetMap and Apple map links, and geo: URIs, without any network request.
 * Returns null when the text holds no recognisable position (e.g. an address).
 */
export function parseLocationInput(text: string): ParsedLocation | null {
  const t = text.trim();
  if (!t) return null;

  // Plain coordinates, optionally with hemisphere letters: "52.3716 N, 4.8865 E".
  const plain = t.match(new RegExp(`^(${NUM})\\s*°?\\s*([NS])?\\s*[,;\\s]\\s*(${NUM})\\s*°?\\s*([EW])?$`, 'i'));
  if (plain) {
    let lat = Number(plain[1]);
    let lon = Number(plain[3]);
    if (plain[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
    if (plain[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
    return valid(lat, lon) ? { lat, lon, kind: 'coordinates' } : null;
  }

  // geo:52.37,4.88?z=18
  const geo = t.match(new RegExp(`^geo:(${NUM}),(${NUM})`, 'i'));
  if (geo) {
    const lat = Number(geo[1]);
    const lon = Number(geo[2]);
    const z = t.match(/[?&]z=(\d+(?:\.\d+)?)/);
    return valid(lat, lon) ? { lat, lon, kind: 'geo-uri', ...(z ? { zoom: Number(z[1]) } : {}) } : null;
  }

  if (!looksLikeLink(t)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const full = decodeURIComponent(url.href);
  const q = url.searchParams;

  if (host.includes('openstreetmap.') || host.includes('osm.org')) {
    const mlat = Number(q.get('mlat'));
    const mlon = Number(q.get('mlon'));
    if (q.has('mlat') && q.has('mlon') && valid(mlat, mlon)) return { lat: mlat, lon: mlon, kind: 'osm', zoom: 18 };
    const m = full.match(new RegExp(`map=(\\d+(?:\\.\\d+)?)/(${NUM})/(${NUM})`));
    if (m && valid(Number(m[2]), Number(m[3]))) return { lat: Number(m[2]), lon: Number(m[3]), zoom: Number(m[1]), kind: 'osm' };
    return null;
  }

  if (host.includes('google.') || host.startsWith('goo.gl') || host.includes('maps.app.goo.gl')) {
    // A place pin (!3d lat !4d lon) is more precise than the viewport centre (@lat,lon,zoom).
    const pin = full.match(new RegExp(`!3d(${NUM})!4d(${NUM})`));
    if (pin && valid(Number(pin[1]), Number(pin[2]))) return { lat: Number(pin[1]), lon: Number(pin[2]), kind: 'google', zoom: 18 };
    for (const key of ['q', 'query', 'll', 'center', 'destination', 'daddr']) {
      const p = pair(q.get(key));
      if (p) return { ...p, kind: 'google', zoom: 18 };
    }
    const at = full.match(new RegExp(`@(${NUM}),(${NUM})(?:,(\\d+(?:\\.\\d+)?)z)?`));
    if (at && valid(Number(at[1]), Number(at[2]))) return { lat: Number(at[1]), lon: Number(at[2]), kind: 'google', ...(at[3] ? { zoom: Number(at[3]) } : {}) };
    const place = full.match(new RegExp(`/(?:place|search)/(${NUM}),\\s*(${NUM})`));
    if (place && valid(Number(place[1]), Number(place[2]))) return { lat: Number(place[1]), lon: Number(place[2]), kind: 'google', zoom: 18 };
    return null; // short links (maps.app.goo.gl/…) cannot be resolved without a request
  }

  if (host.includes('apple.com')) {
    for (const key of ['coordinate', 'll', 'q', 'sll', 'center', 'daddr']) {
      const p = pair(q.get(key));
      if (p) return { ...p, kind: 'apple', zoom: 18 };
    }
    return null;
  }

  // Any other link carrying an obvious lat/lon pair.
  for (const key of ['ll', 'latlng', 'latlon', 'q', 'center']) {
    const p = pair(q.get(key));
    if (p) return { ...p, kind: 'link' };
  }
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon') ?? q.get('lng'));
  if (q.has('lat') && (q.has('lon') || q.has('lng')) && valid(lat, lon)) return { lat, lon, kind: 'link' };
  return null;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Area-weighted centroid of a ring (vertex mean for degenerate rings). */
export function ringCentroid(r: Vec2[]): Vec2 {
  const a = ringArea(r);
  if (Math.abs(a) < 1e-9) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    const k = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

const reproj = (p: Vec2, from: LatLon, to: LatLon): Vec2 => lonLatToEnu(to, enuToLonLat(from, p));

/** Re-express ENU footprints given relative to `from` in the ENU frame of `to` (through lon/lat). */
export function reprojectFootprints(fps: Footprint[], from: LatLon, to: LatLon): Footprint[] {
  if (from.lat === to.lat && from.lon === to.lon) return fps.map((f) => structuredClone(f));
  return fps.map((f) => {
    const out: Footprint = { ...structuredClone(f), ring: f.ring.map((p) => reproj(p, from, to)) };
    if (f.holes) out.holes = f.holes.map((h) => h.map((p) => reproj(p, from, to)));
    return out;
  });
}

/**
 * A footprint the user drew by clicking its corners (lon/lat), in the ENU frame of `origin`.
 * Counter-clockwise, open, id 'user/<lat>,<lon>' (centroid), source 'user' (provenance manual).
 */
export function footprintFromCorners(corners: LatLon[], origin: LatLon): Footprint {
  if (corners.length < 3) throw new Error('A footprint needs at least 3 corners.');
  let ring = corners.map((c) => lonLatToEnu(origin, c));
  const f = ring[0];
  const l = ring[ring.length - 1];
  if (ring.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) ring = ring.slice(0, -1);
  if (Math.abs(ringArea(ring)) < 1) throw new Error('The drawn outline is too small (under 1 m²).');
  if (!ringIsCCW(ring)) ring = ring.slice().reverse();
  const c = enuToLonLat(origin, ringCentroid(ring));
  return { id: `user/${c.lat.toFixed(6)},${c.lon.toFixed(6)}`, ring, tags: { building: 'yes', 'sunvision:source': 'manual' }, source: 'user' };
}

/** Footprint ring as a closed GeoJSON lon/lat ring. */
export function footprintToLngLat(fp: Pick<Footprint, 'ring'>, origin: LatLon): [number, number][] {
  const r = fp.ring.map((p) => {
    const g = enuToLonLat(origin, p);
    return [g.lon, g.lat] as [number, number];
  });
  return r.length ? [...r, r[0]] : r;
}

/* ------------------------------------------------------------------ */
/* Camera placement                                                    */
/* ------------------------------------------------------------------ */

export interface CameraPlacement {
  /** ENU ground position, in the same frame as the footprints it was computed from. */
  position: Vec2;
  heading: number;
  provenance: { position: Provenance; heading: Provenance };
  /**
   * 'gps' = EXIF GPS; 'street' / 'longest-edge' = autoCameraForBuilding; 'manual' = dragged;
   * 'side' = across the facade the user picked in the direction picker (distance assumed).
   */
  basis: 'gps' | 'street' | 'longest-edge' | 'manual' | 'side';
  notes: string[];
}

export interface PlaceCameraOptions {
  /** EXIF GPS position, in the footprints' ENU frame. */
  gps?: Vec2;
  /** EXIF GPSImgDirection (deg). */
  exifHeading?: number;
  /** EXIF GPSImgDirectionRef: 'T' (true north) or 'M' (magnetic). */
  exifHeadingRef?: string;
  /** Stand-off for the automatic placement (default AUTO_CAMERA_DISTANCE = 15 m). */
  distance?: number;
}

/** Compass heading from `from` to the target's centroid. */
export function aimAtFootprint(from: Vec2, target: Pick<Footprint, 'ring'>): number {
  const c = ringCentroid(target.ring);
  return bearingOf(c[0] - from[0], c[1] - from[1]);
}

/**
 * The camera for a picked building:
 *  - with GPS: the GPS point, aimed at the building's centroid (inferred) unless EXIF has a
 *    heading (observed);
 *  - without GPS: AUTO_CAMERA_DISTANCE out from the midpoint of the facade that faces the
 *    nearest street (or the longest facade when no street is known), facing it, assumed.
 */
export function placeCamera(target: Footprint, footprints: Footprint[], streets: Street[], opts: PlaceCameraOptions = {}): CameraPlacement {
  if (opts.gps) {
    const hasHeading = typeof opts.exifHeading === 'number' && Number.isFinite(opts.exifHeading);
    const notes = ['Camera position from the photo’s EXIF GPS.'];
    if (hasHeading) notes.push(`Viewing direction ${opts.exifHeading!.toFixed(0)}° from EXIF${opts.exifHeadingRef === 'M' ? ' (magnetic north, not corrected for declination)' : ''}.`);
    else notes.push('No compass heading in EXIF: aimed at the picked building’s centre.');
    return {
      position: [opts.gps[0], opts.gps[1]],
      heading: hasHeading ? ((opts.exifHeading! % 360) + 360) % 360 : aimAtFootprint(opts.gps, target),
      provenance: { position: 'observed', heading: hasHeading ? 'observed' : 'inferred' },
      basis: 'gps',
      notes,
    };
  }
  const d = opts.distance ?? AUTO_CAMERA_DISTANCE;
  const others = footprints.filter((f) => f.id !== target.id);
  const auto = autoCameraForBuilding(target, streets, { others, minDistance: d, maxCameraDistance: d });
  return {
    position: auto.position,
    heading: auto.heading,
    provenance: { position: 'assumed', heading: 'assumed' },
    basis: auto.basis,
    notes: [
      auto.basis === 'street'
        ? `No GPS in the photo: camera assumed ${d} m in front of the facade that faces the nearest street, looking at it. Drag it to where you stood.`
        : `No GPS in the photo and no street found: camera assumed ${d} m in front of the longest facade, looking at it. Drag it to where you stood.`,
    ],
  };
}

/** The camera after the user dragged it: position manual, aimed at the building (inferred). */
export function draggedCamera(position: Vec2, target: Pick<Footprint, 'ring'>, prev?: CameraPlacement): CameraPlacement {
  const keepHeading = prev?.provenance.heading === 'observed' || prev?.provenance.heading === 'manual';
  return {
    position,
    heading: keepHeading ? prev!.heading : aimAtFootprint(position, target),
    provenance: { position: 'manual', heading: keepHeading ? prev!.provenance.heading : 'inferred' },
    basis: 'manual',
    notes: ['Camera position placed by you on the map.', keepHeading ? 'Viewing direction kept from before.' : 'Aimed at the picked building’s centre.'],
  };
}

/* ------------------------------------------------------------------ */
/* Direction picker: which side of the building the photo shows         */
/* ------------------------------------------------------------------ */

export type CompassPoint = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
const POINTS: CompassPoint[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const POINT_WORDS: Record<CompassPoint, string> = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** 8-point compass label of a bearing (deg clockwise from north). */
export function compassPoint(deg: number): CompassPoint {
  return POINTS[Math.round(norm360(deg) / 45) % 8];
}

/** The compass point as a word ("north-east"). */
export function compassWord(deg: number): string {
  return POINT_WORDS[compassPoint(deg)];
}

/** One side (facade) of a footprint: one edge, or several nearly collinear consecutive edges. */
export interface FacadeSide {
  /** Ring edges in this side (edge i runs from ring[i] to ring[i+1]). */
  edges: number[];
  /** The longest edge of the side: the camera is placed across its midpoint. */
  edge: number;
  /** Total length (m). */
  length: number;
  /** Midpoint of the representative edge (ENU m, the footprint's frame). */
  mid: Vec2;
  /** Outward unit normal of the representative edge. */
  normal: Vec2;
  /** Compass bearing the facade faces (its outward normal). */
  faces: number;
  label: CompassPoint;
}

export interface FacadeSideOptions {
  /** Sides shorter than this are left out (m). Default 3. */
  minLength?: number;
  /** At most this many sides, the longest ones. Default 6. */
  max?: number;
  /** Consecutive edges whose normals differ by less than this (deg) form one side. Default 20. */
  mergeAngle?: number;
  /** Edges shorter than this (m) between two parallel parts are a jog in one facade. Default 1.5. */
  jogLength?: number;
}

/**
 * The facades a photo can show, for the direction picker: consecutive nearly collinear
 * edges are merged (tile outlines often split a straight facade, sometimes with a small
 * jog between the parts: jogs shorter than `jogLength` join the facade), sides shorter than
 * `minLength` are dropped and at most `max` of the longest are kept, ordered clockwise
 * from north by the direction they face. When no side reaches `minLength` (a tiny or
 * odd outline), the four longest are returned so there is always a choice.
 */
/**
 * Sides offered by the upload direction picker (chips and map arrows; the arrows de-overlap on
 * their own). Higher than facadeSides' default so a courtyard or notch wall stays pickable.
 */
export const SIDE_CHIPS_MAX = 12;

export function facadeSides(target: Pick<Footprint, 'ring'>, opts: FacadeSideOptions = {}): FacadeSide[] {
  const minLen = opts.minLength ?? 3;
  const max = opts.max ?? 6;
  const mergeCos = Math.cos(((opts.mergeAngle ?? 20) * Math.PI) / 180);
  const ring = target.ring;
  const n = ring.length;
  if (n < 3) return [];
  const ccw = ringIsCCW(ring);
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nn = edgeNormal(a, b, ccw);
    return { i, a, b, len, nn };
  });
  const usable = edges.filter((e) => e.len > 1e-6);
  if (!usable.length) return [];
  const jog = opts.jogLength ?? 1.5;
  const dot = (u: Vec2, v: Vec2) => u[0] * v[0] + u[1] * v[1];
  // Start the grouping at a long edge whose previous long edge faces another way, so a side is
  // never split across the start of the ring.
  let start = 0;
  for (let k = 0; k < usable.length; k++) {
    const cur = usable[k];
    if (cur.len < jog) continue;
    let j = k;
    let prev = cur;
    for (let step = 0; step < usable.length; step++) {
      j = (j - 1 + usable.length) % usable.length;
      if (usable[j].len >= jog) {
        prev = usable[j];
        break;
      }
    }
    if (prev === cur || dot(prev.nn, cur.nn) < mergeCos) {
      start = k;
      break;
    }
  }
  type E = (typeof usable)[number];
  const groups: { edges: E[]; jogs: Set<number> }[] = [];
  let pending: E[] = [];
  const flush = () => {
    for (const p of pending) groups.push({ edges: [p], jogs: new Set() });
    pending = [];
  };
  for (let k = 0; k < usable.length; k++) {
    const e = usable[(start + k) % usable.length];
    const g = groups[groups.length - 1];
    // Compare with the group's first edge so a gentle curve does not merge into one side.
    if (g && dot(g.edges[0].nn, e.nn) >= mergeCos) {
      // Short jogs between two parallel parts belong to the same facade.
      for (const p of pending) {
        g.edges.push(p);
        g.jogs.add(p.i);
      }
      pending = [];
      g.edges.push(e);
    } else if (g && e.len < jog) pending.push(e);
    else {
      flush();
      groups.push({ edges: [e], jogs: new Set() });
    }
  }
  flush();
  const sides: FacadeSide[] = groups.map(({ edges: g, jogs }) => {
    const main = g.filter((e) => !jogs.has(e.i));
    const rep = main.reduce((m, e) => (e.len > m.len ? e : m), main[0]);
    const faces = bearingOf(rep.nn[0], rep.nn[1]);
    return {
      edges: g.map((e) => e.i),
      edge: rep.i,
      length: main.reduce((sum, e) => sum + e.len, 0),
      mid: [(rep.a[0] + rep.b[0]) / 2, (rep.a[1] + rep.b[1]) / 2],
      normal: rep.nn,
      faces,
      label: compassPoint(faces),
    };
  });
  let keep = sides.filter((s) => s.length >= minLen);
  if (!keep.length) keep = [...sides].sort((a, b) => b.length - a.length).slice(0, 4);
  if (keep.length > max) keep = [...keep].sort((a, b) => b.length - a.length).slice(0, max);
  return keep.sort((a, b) => a.faces - b.faces);
}

function edgeNormal(a: Vec2, b: Vec2, ccw: boolean): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return ccw ? [dy / l, -dx / l] : [-dy / l, dx / l];
}

/**
 * The side a camera currently shows: the side containing the edge its viewing ray hits
 * (lib/sceneBuilder `facingEdge`, the same rule the scene uses), else the side whose
 * outward normal points most towards the camera.
 */
export function currentSide(target: Footprint, sides: FacadeSide[], camera: Pick<CameraPlacement, 'position' | 'heading'>): FacadeSide | null {
  if (!sides.length) return null;
  const e = facingEdge(target, camera.position, camera.heading);
  const hit = sides.find((s) => s.edges.includes(e));
  if (hit) return hit;
  let best: FacadeSide | null = null;
  let bestDot = -Infinity;
  for (const s of sides) {
    const dx = camera.position[0] - s.mid[0];
    const dy = camera.position[1] - s.mid[1];
    const l = Math.hypot(dx, dy) || 1;
    const dot = (dx * s.normal[0] + dy * s.normal[1]) / l;
    if (dot > bestDot) {
      bestDot = dot;
      best = s;
    }
  }
  return best;
}

/** The side facing most nearly the opposite way (for "Flip to the opposite side"). */
export function oppositeSide(sides: FacadeSide[], from: FacadeSide): FacadeSide | null {
  let best: FacadeSide | null = null;
  let bestDot = Infinity;
  for (const s of sides) {
    if (s === from || s.edge === from.edge) continue;
    const dot = s.normal[0] * from.normal[0] + s.normal[1] * from.normal[1];
    if (dot < bestDot) {
      bestDot = dot;
      best = s;
    }
  }
  return best;
}

/**
 * The camera across a facade the user picked: `distance` m (default AUTO_CAMERA_DISTANCE)
 * out from its midpoint along the outward normal, looking straight at it. A stand-off is used
 * only when it is outside every building (the target included: in a courtyard or notch the
 * normal can run into the building's other wing) and the viewing ray first hits the picked
 * side; nearer and then farther stand-offs are tried, then 1–3 m. The side was chosen by the
 * user, but the stand-off is a guess: position 'assumed', heading 'inferred' (so auto-alignment
 * may still refine it). The dot stays draggable.
 *
 * `opts.gps`: the photo's observed standing point. When it is in front of the picked side (and
 * sees it), it is kept (position 'observed') and only the heading is aimed at the side.
 */
export function cameraForSide(
  side: FacadeSide,
  others: Pick<Footprint, 'ring' | 'id'>[] = [],
  opts: { distance?: number; targetId?: string; gps?: Vec2 } = {},
): CameraPlacement {
  const d0 = opts.distance ?? AUTO_CAMERA_DISTANCE;
  const target = opts.targetId ? others.find((o) => o.id === opts.targetId) : undefined;
  const word = compassWord(side.faces);
  /** Outside every building, and the ray from p towards `aim` first meets the picked side. */
  const usable = (p: Vec2, heading: number) => {
    if (others.some((o) => pointInRing(p, o.ring))) return false;
    if (!target) return true;
    const hit = firstHit([target as Footprint], p, heading);
    return !hit || side.edges.includes(hit.edge);
  };

  const gps = opts.gps;
  if (gps && Number.isFinite(gps[0]) && Number.isFinite(gps[1])) {
    const front = (gps[0] - side.mid[0]) * side.normal[0] + (gps[1] - side.mid[1]) * side.normal[1] > 0;
    const heading = bearingOf(side.mid[0] - gps[0], side.mid[1] - gps[1]);
    if (front && usable(gps, heading))
      return {
        position: gps,
        heading,
        provenance: { position: 'observed', heading: 'inferred' },
        basis: 'gps',
        notes: [`You picked the ${word} facade: the photo's GPS point is kept, aimed at the middle of that facade.`],
      };
  }

  const heading = bearingOf(-side.normal[0], -side.normal[1]);
  const at = (t: number): Vec2 => [side.mid[0] + side.normal[0] * t, side.mid[1] + side.normal[1] * t];
  const tries = [d0, d0 * 0.66, d0 * 0.45, d0 * 0.3, d0 * 1.4, d0 * 1.8, 3, 2, 1];
  let d = d0;
  let position = at(d0);
  let found = false;
  for (const t of tries) {
    if (usable(at(t), heading)) {
      d = t;
      position = at(t);
      found = true;
      break;
    }
  }
  const notes = [`You picked the ${word} facade: camera assumed ${Math.round(d)} m in front of it, looking straight at it. Drag the dot to where you stood.`];
  if (!found) notes.push('No free spot in front of this facade was found (other buildings are in the way); check the camera dot on the map.');
  else if (d < 3) notes.push(`There is only about ${Math.round(d)} m of open space in front of this facade.`);
  if (gps) notes.push('The photo’s GPS point is not in front of this facade, so the camera was moved to it.');
  return {
    position,
    heading,
    provenance: { position: 'assumed', heading: 'inferred' },
    basis: 'side',
    notes,
  };
}

/** Turn the camera by `delta` degrees (fine heading control). The heading becomes manual. */
export function turnCamera(cam: CameraPlacement, delta: number): CameraPlacement {
  const heading = Math.round(norm360(cam.heading + delta) * 10) / 10;
  const notes = cam.notes.filter((n) => !n.startsWith('Viewing direction set by you'));
  return { ...cam, heading, provenance: { ...cam.provenance, heading: 'manual' }, notes: [...notes, `Viewing direction set by you (${heading.toFixed(0)}°).`] };
}

/** "Photo looks west at the east facade." */
export function describeDirection(heading: number, side: Pick<FacadeSide, 'faces'> | null): string {
  const look = compassWord(heading);
  return side ? `Photo looks ${look} at the ${compassWord(side.faces)} facade.` : `Photo looks ${look}.`;
}

/* ------------------------------------------------------------------ */
/* Analysis helpers                                                    */
/* ------------------------------------------------------------------ */

/** An empty analysis for manual annotation. No detection is invented. */
export function manualAnalysis(imageWidth: number, imageHeight: number, warning: string): FacadeAnalysis {
  return { model: { provider: 'manual', modelId: 'manual-annotation' }, imageWidth, imageHeight, detections: [], floorRows: [], warnings: [warning], pipelineVersion: 'manual' };
}

/** Number of (non-deleted) window detections. */
export function countWindows(a: Pick<FacadeAnalysis, 'detections'> | null | undefined): number {
  return a ? a.detections.filter((d) => d.cls === 'window' && !d.deleted).length : 0;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export interface TileSceneInput {
  id: string;
  title: string;
  image: ImageInfo;
  analysis: FacadeAnalysis;
  /** ENU origin of `footprints`, `streets` and `camera.position`. */
  frameOrigin: LatLon;
  /** Tile footprints ('omt/…') and/or drawn ones ('user/…'). */
  footprints: Footprint[];
  streets?: Street[];
  targetId: string;
  camera: CameraPlacement;
  /** Optional Overpass enrichment (OSM ids, height tags, trees, roads). */
  osm?: OsmElement[] | null;
  /** City / country for the title bar, e.g. from the geocoder. */
  place?: { city?: string; country?: string };
  /** Retrieval date for the data sources (YYYY-MM-DD); default today. */
  retrieved?: string;
}

/** Intersection-over-union of two rings (via the edge-overlay union of lib/tiles.ts). */
function ringIoU(a: Vec2[], b: Vec2[]): number {
  const A = Math.abs(ringArea(a));
  const B = Math.abs(ringArea(b));
  const U = unionRings([a], [b]).reduce((s, r) => s + ringArea(r), 0);
  if (!(U > 0)) return 0;
  return Math.max(0, A + B - U) / U;
}

interface Enrichment {
  footprints: Footprint[];
  trees: Tree[];
  roads: NonNullable<Scene['roads']>;
  matched: number;
}

/** Merge Overpass elements into tile footprints (matched by IoU ≥ 0.5), plus trees and roads. */
function enrich(footprints: Footprint[], osm: OsmElement[], origin: LatLon): Enrichment {
  const trees: Tree[] = [];
  const roads: NonNullable<Scene['roads']> = [];
  const out = footprints.map((f) => ({ ...f, tags: { ...f.tags } }));
  let matched = 0;
  const centroids = out.map((f) => ringCentroid(f.ring));
  for (const e of osm) {
    const tags = e.tags ?? {};
    if (e.type === 'node' && tags.natural === 'tree' && e.lat != null && e.lon != null) {
      const h = parseHeight(tags.height);
      const cr = parseHeight(tags.diameter_crown);
      trees.push({ id: `node/${e.id}`, osmId: `node/${e.id}`, position: lonLatToEnu(origin, { lat: e.lat, lon: e.lon }), height: h ?? 10, crownRadius: cr ? cr / 2 : 3, source: h ? 'map' : 'assumed', enabled: true });
      continue;
    }
    if (e.type === 'way' && tags.highway && e.geometry) {
      roads.push({ id: `way/${e.id}`, line: e.geometry.map((p) => lonLatToEnu(origin, p)), tags });
      continue;
    }
    if (!tags.building) continue;
    const ring = ringFromGeometry(elementOuter(e), origin);
    if (!ring) continue;
    const c = ringCentroid(ring);
    let best = -1;
    let bestIoU = 0.5;
    out.forEach((f, i) => {
      if (f.source !== 'osm' || f.tags['sunvision:osm_id']) return;
      if (Math.hypot(centroids[i][0] - c[0], centroids[i][1] - c[1]) > 30) return;
      const iou = ringIoU(f.ring, ring);
      if (iou > bestIoU) {
        bestIoU = iou;
        best = i;
      }
    });
    if (best < 0) continue;
    const f = out[best];
    const own = Object.fromEntries(Object.entries(f.tags).filter(([k]) => k.startsWith('sunvision:')));
    f.tags = { ...f.tags, ...tags, ...own, 'sunvision:osm_id': `${e.type}/${e.id}` };
    const h = parseHeight(tags.height);
    if (h) {
      f.mapHeight = h;
      f.tags['sunvision:height_source'] = 'osm:height';
    }
    if (tags['building:levels']) {
      const lv = Number(tags['building:levels']) + (Number(tags['roof:levels']) || 0);
      if (Number.isFinite(lv) && lv > 0) f.mapLevels = lv;
    }
    matched++;
  }
  return { footprints: out, trees, roads, matched };
}

/**
 * Footprints (tile or drawn) + camera placement + analysis → Scene, mirroring
 * `buildScene` in lib/sceneBuilder.ts. Pitch, roll and lens height are assumed; the
 * camera is solved afterwards by `alignTileScene`.
 */
export function buildTileScene(inp: TileSceneInput): Scene {
  const target0 = inp.footprints.find((f) => f.id === inp.targetId);
  if (!target0) throw new Error('The selected building is not among the loaded footprints.');
  if (target0.ring.length < 3) throw new Error('The selected building has no usable outline.');
  const origin = enuToLonLat(inp.frameOrigin, ringCentroid(target0.ring));
  let footprints = reprojectFootprints(inp.footprints, inp.frameOrigin, origin);
  let target = footprints.find((f) => f.id === inp.targetId)!;
  if (target.source === 'user') {
    // A drawn outline replaces whatever the tiles had at that spot.
    footprints = footprints.filter((f) => f.id === target.id || !pointInRing(ringCentroid(f.ring), target.ring));
  }
  for (const f of footprints) if (!ringIsCCW(f.ring)) f.ring = f.ring.slice().reverse();

  let trees: Tree[] = [];
  let roads: NonNullable<Scene['roads']> = (inp.streets ?? []).map((s) => ({ id: s.id, line: s.line.map((p) => reproj(p, inp.frameOrigin, origin)), tags: { ...s.tags } }));
  let enriched = 0;
  if (inp.osm?.length) {
    const en = enrich(footprints, inp.osm, origin);
    footprints = en.footprints;
    trees = en.trees;
    if (en.roads.length) roads = en.roads;
    enriched = en.matched;
    target = footprints.find((f) => f.id === inp.targetId)!;
  }

  const camPos = reproj(inp.camera.position, inp.frameOrigin, origin);
  const heading = inp.camera.heading;
  const fov = fovFromExif(inp.image.exif, inp.image.width, inp.image.height);
  const facadeEdgeIndex = facingEdge(target, camPos, heading);
  const visible = new Set<string>();
  for (let a = -fov.hfov / 2; a <= fov.hfov / 2 + 1e-9; a += fov.hfov / 24) {
    const hit = firstHit(footprints, camPos, heading + a);
    if (hit && hit.t < 120 && hit.fp.id !== target.id) visible.add(hit.fp.id);
  }
  const camera: CameraParams = {
    position: camPos,
    height: ASSUMED_LENS_HEIGHT,
    heading,
    pitch: ASSUMED_PITCH,
    roll: 0,
    hfov: fov.hfov,
    provenance: { position: inp.camera.provenance.position, heading: inp.camera.provenance.heading, pitch: 'assumed', hfov: fov.provenance, height: 'assumed' },
    notes: [...inp.camera.notes, fov.note, `Lens height assumed ${ASSUMED_LENS_HEIGHT} m (hand-held).`],
  };
  if (fov.range) camera.hfovRange = fov.range;

  let timezone = 'UTC';
  try {
    timezone = tzlookup(origin.lat, origin.lon);
  } catch {
    /* ocean / unknown */
  }
  const retrieved = inp.retrieved ?? new Date().toISOString().slice(0, 10);
  const dataSources: Scene['dataSources'] = [];
  if (footprints.some((f) => f.tags['sunvision:source'] === 'openmaptiles'))
    dataSources.push({ name: 'OpenStreetMap contributors, via OpenFreeMap vector tiles (OpenMapTiles schema)', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL 1.0', retrieved });
  if (inp.osm?.length) dataSources.push({ name: `OpenStreetMap contributors (Overpass API; ${enriched} footprint${enriched === 1 ? '' : 's'} matched)`, url: 'https://www.openstreetmap.org/copyright', license: 'ODbL 1.0', retrieved });
  if (target.source === 'user') dataSources.push({ name: 'Building outline drawn by you', url: '', license: '—', retrieved });

  return {
    id: inp.id,
    title: inp.title,
    city: target.tags['addr:city'] ?? inp.place?.city ?? '',
    country: target.tags['addr:country'] ?? inp.place?.country ?? '',
    description: 'Uploaded photograph',
    origin,
    timezone,
    image: inp.image,
    camera,
    footprints,
    roads,
    trees,
    targetBuildingId: target.id,
    facadeEdgeIndex,
    visibleBuildingIds: [...visible],
    analysis: inp.analysis,
    dataSources,
  };
}

export interface AlignedScene {
  scene: Scene;
  /** True when facade-regularity alignment changed the camera. */
  aligned: boolean;
  notes: string[];
}

/**
 * Solve the camera of a freshly built scene: in an oblique street view first start heading,
 * pitch and an assumed position from the street vanishing point of the window rows
 * (lib/vanishing `obliqueStart`, which also moves the scene's facade edge and visible buildings
 * with the camera), then `calibratePitch` (assumed pitch only), then `autoAlignCamera` bounded by
 * the EXIF FOV range. Manual parameters never move. The result becomes the scene's reference
 * camera, so "Reset camera" returns to it.
 */
export function alignTileScene(scene0: Scene): AlignedScene {
  let scene = scene0;
  let camera: CameraParams = structuredClone(scene.camera);
  const notes: string[] = [];
  const live = scene.analysis.detections.filter((d) => !d.deleted);
  const ob = obliqueStart(scene, camera, live);
  notes.push(...ob.notes);
  if (ob.applied) {
    camera = structuredClone(ob.camera);
    scene = { ...scene, facadeEdgeIndex: ob.facadeEdgeIndex, visibleBuildingIds: ob.visibleBuildingIds };
  }
  if (camera.provenance.pitch === 'assumed') {
    const p = calibratePitch(scene, camera);
    if (p != null) {
      const note = `Pitch solved to ${p.toFixed(1)}° so the detected facade ground line lies at street level (was ${camera.pitch}°, assumed).`;
      camera = { ...camera, pitch: Math.round(p * 10) / 10, provenance: { ...camera.provenance, pitch: 'inferred' }, notes: [...(camera.notes ?? []), note] };
      notes.push(note);
    }
  }
  const al = autoAlignCamera({ ...scene, camera, detections: live }, { hfovRange: camera.hfovRange, vanishingPoint: ob.constraint });
  if (al.changed) camera = al.camera;
  notes.push(...al.notes);
  return { scene: { ...scene, camera }, aligned: al.changed || ob.applied, notes };
}

/** buildTileScene + alignTileScene: the scene the upload flow hands to `store.loadScene`. */
export function prepareTileScene(inp: TileSceneInput): AlignedScene {
  return alignTileScene(buildTileScene(inp));
}

/**
 * Start camera for re-solving after a late analysis: the scene's original (unsolved)
 * camera, with every field the user corrected by hand ('manual') taken from `current`.
 */
export function mergeManualCamera(base: CameraParams, current: CameraParams | null | undefined): CameraParams {
  const out: CameraParams = structuredClone(base);
  if (!current) return out;
  const p = current.provenance;
  if (p.position === 'manual') {
    out.position = [current.position[0], current.position[1]];
    out.provenance.position = 'manual';
  }
  if (p.heading === 'manual') {
    out.heading = current.heading;
    out.provenance.heading = 'manual';
  }
  if (p.pitch === 'manual') {
    out.pitch = current.pitch;
    out.roll = current.roll;
    out.provenance.pitch = 'manual';
  }
  if (p.hfov === 'manual') {
    out.hfov = current.hfov;
    out.provenance.hfov = 'manual';
  }
  if (p.height === 'manual') {
    out.height = current.height;
    out.provenance.height = 'manual';
  }
  if (current.alignment) out.alignment = structuredClone(current.alignment);
  return out;
}
