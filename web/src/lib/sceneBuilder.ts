/**
 * Assemble a Scene in the browser from an uploaded photo, user-placed camera,
 * a chosen OSM building and (optionally) a live facade analysis.
 * Mirrors scripts/build_scene.py so curated and uploaded scenes behave identically.
 */
import tzlookup from 'tz-lookup';
import type { CameraParams, FacadeAnalysis, Footprint, LatLon, Scene, Tree, Vec2 } from '../schema/scene';
import { lonLatToEnu } from '../engine';
import { edgeOutwardNormal, ringIsCCW } from './camera';
import { parseHeight, type OsmElement } from './osm';

export function ringFromGeometry(g: { lat: number; lon: number }[] | undefined, origin: LatLon): Vec2[] | null {
  if (!g || g.length < 4) return null;
  let ring = g.map((p) => lonLatToEnu(origin, p));
  const f = ring[0];
  const l = ring[ring.length - 1];
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) ring = ring.slice(0, -1);
  if (ring.length < 3) return null;
  if (!ringIsCCW(ring)) ring.reverse();
  return ring;
}

export function centroidLL(g: { lat: number; lon: number }[]): LatLon {
  const n = g.length;
  return { lat: g.reduce((a, p) => a + p.lat, 0) / n, lon: g.reduce((a, p) => a + p.lon, 0) / n };
}

export function elementOuter(e: OsmElement) {
  if (e.type === 'way') return e.geometry;
  if (e.type === 'relation') return e.members?.find((m) => m.role === 'outer' && m.geometry)?.geometry;
  return undefined;
}

export function pointInRing(p: Vec2, ring: Vec2[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 2D ray (origin, unit dir) vs segment; returns distance or null. */
function raySeg(o: Vec2, d: Vec2, a: Vec2, b: Vec2): number | null {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
  const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
  return t > 0 && u >= 0 && u <= 1 ? t : null;
}

/** First footprint edge hit by a horizontal ray from the camera. */
export function firstHit(footprints: Footprint[], o: Vec2, headingDeg: number) {
  const h = (headingDeg * Math.PI) / 180;
  const d: Vec2 = [Math.sin(h), Math.cos(h)];
  let best: { fp: Footprint; edge: number; t: number } | null = null;
  for (const fp of footprints) {
    for (let i = 0; i < fp.ring.length; i++) {
      const t = raySeg(o, d, fp.ring[i], fp.ring[(i + 1) % fp.ring.length]);
      if (t != null && (!best || t < best.t)) best = { fp, edge: i, t };
    }
  }
  return best;
}

/** The camera-facing edge of a footprint closest to the viewing ray. */
export function facingEdge(fp: Footprint, cam: Vec2, headingDeg: number): number {
  const hit = firstHit([fp], cam, headingDeg);
  if (hit) return hit.edge;
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < fp.ring.length; i++) {
    const a = fp.ring[i];
    const b = fp.ring[(i + 1) % fp.ring.length];
    const n = edgeOutwardNormal(a, b);
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const to: Vec2 = [cam[0] - mid[0], cam[1] - mid[1]];
    const dist = Math.hypot(to[0], to[1]) || 1;
    const facing = (to[0] * n[0] + to[1] * n[1]) / dist;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const score = facing * 2 + Math.min(1, len / 10) - dist / 200;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export interface BuildSceneInput {
  id: string;
  title: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  cameraLL: LatLon;
  heading: number;
  headingProv: 'observed' | 'manual' | 'inferred';
  cameraProv: 'observed' | 'manual';
  hfov?: number;
  focal35?: number;
  elements: OsmElement[];
  targetOsmId: string; // 'way/123'
  analysis: FacadeAnalysis;
  exif?: Scene['image']['exif'];
}

export function buildScene(inp: BuildSceneInput): Scene {
  const targetEl = inp.elements.find((e) => `${e.type}/${e.id}` === inp.targetOsmId);
  const outer = targetEl ? elementOuter(targetEl) : undefined;
  if (!targetEl || !outer) throw new Error('Selected building has no usable footprint geometry.');
  const origin = centroidLL(outer.slice(0, -1));
  const footprints: Footprint[] = [];
  const trees: Tree[] = [];
  const roads: NonNullable<Scene['roads']> = [];
  for (const e of inp.elements) {
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
    if (!(tags.building || tags['building:part'])) continue;
    if (tags['building:part'] && !tags.building) continue; // parts are ignored for the MVP (outline used)
    const ring = ringFromGeometry(elementOuter(e), origin);
    if (!ring) continue;
    footprints.push({ id: `${e.type}/${e.id}`, ring, tags, mapHeight: parseHeight(tags.height), mapLevels: tags['building:levels'] ? Number(tags['building:levels']) + (Number(tags['roof:levels']) || 0) : undefined, source: 'osm' });
  }
  const camPos = lonLatToEnu(origin, inp.cameraLL);
  const target = footprints.find((f) => f.id === inp.targetOsmId)!;
  const facadeEdgeIndex = facingEdge(target, camPos, inp.heading);
  const hfov = inp.hfov ?? (inp.focal35 ? (2 * Math.atan(36 / (2 * inp.focal35)) * 180) / Math.PI : 60);
  // Other buildings hit by rays across the field of view are "visible" (their facades may be measured).
  const visible = new Set<string>();
  for (let a = -hfov / 2; a <= hfov / 2; a += hfov / 24) {
    const hit = firstHit(footprints, camPos, inp.heading + a);
    if (hit && hit.t < 120 && hit.fp.id !== target.id) visible.add(hit.fp.id);
  }
  const camera: CameraParams = {
    position: camPos,
    height: 1.6,
    heading: inp.heading,
    pitch: 8,
    roll: 0,
    hfov,
    provenance: { position: inp.cameraProv, heading: inp.headingProv, pitch: 'assumed', hfov: inp.hfov || inp.focal35 ? 'observed' : 'assumed', height: 'assumed' },
    notes: [
      inp.cameraProv === 'observed' ? 'Camera position from photo EXIF GPS.' : 'Camera position placed manually on the map.',
      inp.focal35 ? `Field of view from EXIF 35 mm-equivalent focal length (${inp.focal35} mm).` : 'Field of view assumed (60°) — no focal length in metadata.',
      'Lens height assumed 1.6 m (hand-held).',
    ],
  };
  let timezone = 'UTC';
  try {
    timezone = tzlookup(origin.lat, origin.lon);
  } catch {
    /* ocean / unknown */
  }
  const tagsT = target.tags;
  return {
    id: inp.id,
    title: inp.title,
    city: tagsT['addr:city'] ?? '',
    country: tagsT['addr:country'] ?? '',
    description: 'Uploaded photograph',
    origin,
    timezone,
    image: { url: inp.imageUrl, width: inp.imageWidth, height: inp.imageHeight, exif: inp.exif },
    camera,
    footprints,
    roads,
    trees,
    targetBuildingId: target.id,
    facadeEdgeIndex,
    visibleBuildingIds: [...visible],
    analysis: inp.analysis,
    dataSources: [{ name: 'OpenStreetMap contributors (Overpass API)', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL 1.0', retrieved: new Date().toISOString().slice(0, 10) }],
  };
}
