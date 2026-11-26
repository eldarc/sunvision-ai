import { describe, expect, it } from 'vitest';
import {
  alignTileScene,
  buildTileScene,
  cameraForSide,
  compassPoint,
  currentSide,
  describeDirection,
  draggedCamera,
  facadeSides,
  oppositeSide,
  turnCamera,
  footprintFromCorners,
  hfovFromFocal35,
  hfovRangeFromExif,
  manualAnalysis,
  mergeManualCamera,
  parseLocationInput,
  placeCamera,
  prepareTileScene,
  ringCentroid,
  SIDE_CHIPS_MAX,
  type TileSceneInput,
} from '../tileBuildings';
import { HEIGHT_SOURCE_RENDER, HEIGHT_SOURCE_TAG, footprintsFromTileFeatures, ringArea, type Street, type TileFeatureLike } from '../tiles';
import { enuToLonLat, lonLatToEnu } from '../../engine/geo';
import { reconstruct } from '../reconstruct';
import { defaultSettings } from '../../state/store';
import type { CameraParams, Footprint, LatLon, Vec2 } from '../../schema/scene';
import { pointInRing } from '../sceneBuilder';
import type { OsmElement } from '../osm';

/* Synthetic data in ENU metres around a frame origin (the map centre when footprints were read). */
const frame: LatLon = { lat: 52.37163, lon: 4.88646 }; // Amsterdam
const ll = (p: Vec2): number[] => {
  const g = enuToLonLat(frame, p);
  return [g.lon, g.lat];
};
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const fp = (id: string, ring: Vec2[], extra: Partial<Footprint> = {}): Footprint => ({ id, ring, tags: { building: 'yes', 'sunvision:source': 'openmaptiles' }, source: 'osm', ...extra });

// Target 20 × 10 m, 40 m east of the frame origin; a neighbour across the street to the south.
const target = fp('omt/target', rect(40, 0, 60, 10), { mapHeight: 22 });
const across = fp('omt/across', rect(35, -40, 65, -28), { mapHeight: 15 });
const behind = fp('omt/behind', rect(40, 30, 60, 45), { mapHeight: 9 });
const street: Street = { id: 'omt-street/1', line: [[0, -10], [100, -10]], tags: { highway: 'minor' } };
const image = { url: 'blob:photo', width: 4000, height: 3000 };

const baseInput = (over: Partial<TileSceneInput> = {}): TileSceneInput => {
  const footprints = [target, across, behind];
  const camera = placeCamera(target, footprints, [street]);
  return { id: 'upload-test', title: 'test.jpg', image, analysis: manualAnalysis(4000, 3000, 'manual'), frameOrigin: frame, footprints, streets: [street], targetId: target.id, camera, retrieved: '2026-11-25', ...over };
};

describe('buildTileScene: footprints → Scene', () => {
  it('puts the ENU origin at the target centroid and keeps the other buildings where they were', () => {
    const s = buildTileScene(baseInput());
    const t = s.footprints.find((f) => f.id === target.id)!;
    const c = ringCentroid(t.ring);
    expect(Math.hypot(c[0], c[1])).toBeLessThan(0.01);
    const expectedOrigin = enuToLonLat(frame, [50, 5]);
    expect(s.origin.lat).toBeCloseTo(expectedOrigin.lat, 7);
    expect(s.origin.lon).toBeCloseTo(expectedOrigin.lon, 7);
    // Relative geometry is preserved (to millimetres over ~40 m).
    const a = ringCentroid(s.footprints.find((f) => f.id === across.id)!.ring);
    expect(a[0]).toBeCloseTo(0, 2);
    expect(a[1]).toBeCloseTo(-39, 2);
    expect(Math.abs(ringArea(t.ring))).toBeCloseTo(200, 1);
    for (const f of s.footprints) expect(ringArea(f.ring)).toBeGreaterThan(0); // CCW
    expect(s.roads?.[0].line[0][1]).toBeCloseTo(-15, 2);
  });

  it('places the camera across the street, facing the street facade (assumed), and finds the visible buildings', () => {
    const s = buildTileScene(baseInput());
    expect(s.targetBuildingId).toBe(target.id);
    // Ring starts at the south-west corner, so edge 0 is the south (street) facade.
    expect(s.facadeEdgeIndex).toBe(0);
    expect(s.camera.position[0]).toBeCloseTo(0, 3);
    expect(s.camera.position[1]).toBeCloseTo(-5 - 15, 3);
    expect(s.camera.heading).toBeCloseTo(0, 3);
    expect(s.camera.provenance).toMatchObject({ position: 'assumed', heading: 'assumed', pitch: 'assumed', hfov: 'assumed', height: 'assumed' });
    expect(s.camera.hfov).toBe(60);
    expect(s.camera.hfovRange).toBeUndefined();
    expect(s.visibleBuildingIds).not.toContain(across.id); // behind the camera
    expect(s.visibleBuildingIds).not.toContain(behind.id); // hidden behind the target
    expect(s.timezone).toBe('Europe/Amsterdam');
    expect(s.analysis.detections).toHaveLength(0);
    expect(s.dataSources.map((d) => d.license)).toContain('ODbL 1.0');
  });

  it('uses EXIF GPS (observed) and EXIF heading (observed), or aims at the building (inferred)', () => {
    const gps: Vec2 = [55, -25];
    const aimed = placeCamera(target, [target], [], { gps });
    expect(aimed.provenance).toEqual({ position: 'observed', heading: 'inferred' });
    expect(aimed.heading).toBeCloseTo((Math.atan2(50 - 55, 5 - -25) * 180) / Math.PI + 360, 3);
    const withHeading = placeCamera(target, [target], [], { gps, exifHeading: 352 });
    expect(withHeading.provenance).toEqual({ position: 'observed', heading: 'observed' });
    const s = buildTileScene(baseInput({ camera: withHeading, image: { ...image, exif: { gps: { ...enuToLonLat(frame, gps) }, heading: 352, focalLength35mm: 26 } } }));
    expect(s.camera.heading).toBe(352);
    expect(s.camera.provenance.position).toBe('observed');
    expect(s.camera.provenance.heading).toBe('observed');
    expect(s.camera.provenance.hfov).toBe('observed');
    expect(s.camera.hfov).toBeCloseTo(hfovFromFocal35(26, 4000, 3000), 6);
    expect(s.camera.hfovRange).toEqual(hfovRangeFromExif(s.camera.hfov));
    expect(s.facadeEdgeIndex).toBe(0);
    // A dragged camera is manual and re-aimed at the building.
    const dragged = draggedCamera([30, -20], target, aimed);
    expect(dragged.provenance).toEqual({ position: 'manual', heading: 'inferred' });
  });

  it('derives the FOV from the 35 mm-equivalent focal length with the diagonal convention', () => {
    // 3:2 landscape: identical to 2·atan(36 / 2f).
    expect(hfovFromFocal35(26, 6000, 4000)).toBeCloseTo((2 * Math.atan(36 / 52) * 180) / Math.PI, 1);
    // 4:3 is slightly narrower; portrait much narrower.
    expect(hfovFromFocal35(26, 4000, 3000)).toBeLessThan(hfovFromFocal35(26, 6000, 4000));
    expect(hfovFromFocal35(26, 3000, 4000)).toBeLessThan(hfovFromFocal35(26, 4000, 3000));
    const [lo, hi] = hfovRangeFromExif(70);
    expect(lo).toBeCloseTo(35);
    expect(hi).toBeCloseTo(73.5);
  });

  it('reads render_height with provenance map, after merging two fragments that share an id', () => {
    // A building split into two touching fragments with the same feature id (no tile info).
    const left: Vec2[] = rect(40, 0, 50, 10);
    const right: Vec2[] = rect(50, 0, 60, 10);
    const props = { render_height: 22, render_min_height: 0 };
    const feats: TileFeatureLike[] = [
      { id: 42, properties: props, geometry: { type: 'Polygon', coordinates: [[...left, left[0]].map(ll)] } },
      { id: 42, properties: props, geometry: { type: 'Polygon', coordinates: [[...right, right[0]].map(ll)] } },
      { id: 7, properties: { render_height: 15, render_min_height: 0 }, geometry: { type: 'Polygon', coordinates: [[...across.ring, across.ring[0]].map(ll)] } },
    ];
    const fps = footprintsFromTileFeatures(feats, frame);
    expect(fps).toHaveLength(2);
    const merged = fps.find((f) => f.mapHeight === 22)!;
    expect(merged.tags[HEIGHT_SOURCE_TAG]).toBe(HEIGHT_SOURCE_RENDER);
    expect(Math.abs(ringArea(merged.ring))).toBeCloseTo(200, 0);
    expect(merged.id.startsWith('omt/')).toBe(true);

    const other = fps.find((f) => f !== merged)!;
    const camera = placeCamera(merged, fps, [street]);
    const s = buildTileScene({ ...baseInput(), footprints: fps, targetId: merged.id, camera });
    expect(s.footprints.find((f) => f.id === merged.id)!.mapHeight).toBe(22);
    // In the reconstruction the unseen neighbour's height is the tile height, provenance 'map'.
    const r = reconstruct({ scene: s, camera: s.camera, detections: [], settings: defaultSettings, overrides: {} });
    expect(r.buildings[other.id].height.source).toBe('map');
    expect(r.buildings[other.id].height.value).toBe(15);
    expect(r.buildings[other.id].reconstructedFrom).toBe('map-tag');
  });

  it('merges Overpass enrichment when it arrived: OSM ids, exact height tags, trees, roads', () => {
    const origin = frame;
    const geom = (r: Vec2[]) => [...r, r[0]].map((p) => enuToLonLat(origin, p));
    const t = enuToLonLat(origin, [30, -15]);
    const osm: OsmElement[] = [
      { type: 'way', id: 3581114, tags: { building: 'apartments', height: '21.3', 'building:levels': '6', 'addr:city': 'Amsterdam' }, geometry: geom(rect(40.2, 0.1, 59.8, 9.9)) },
      { type: 'node', id: 99, lat: t.lat, lon: t.lon, tags: { natural: 'tree', height: '12' } },
      { type: 'way', id: 5, tags: { highway: 'residential', name: 'Herengracht' }, geometry: geom([[0, -10], [100, -10]]) },
    ];
    const s = buildTileScene(baseInput({ osm }));
    const tf = s.footprints.find((f) => f.id === target.id)!;
    expect(tf.tags['sunvision:osm_id']).toBe('way/3581114');
    expect(tf.tags.building).toBe('apartments');
    expect(tf.tags['sunvision:source']).toBe('openmaptiles');
    expect(tf.mapHeight).toBe(21.3);
    expect(tf.mapLevels).toBe(6);
    expect(s.city).toBe('Amsterdam');
    expect(s.trees).toHaveLength(1);
    expect(s.trees[0]).toMatchObject({ id: 'node/99', height: 12, source: 'map' });
    expect(s.roads?.[0].tags.name).toBe('Herengracht');
    expect(s.footprints.find((f) => f.id === across.id)!.tags['sunvision:osm_id']).toBeUndefined();
  });

  it('builds from a drawn footprint (manual) that replaces overlapping tile outlines', () => {
    const corners = [[60, 10], [40, 10], [40, 0], [60, 0]].map((p) => enuToLonLat(frame, p as Vec2)); // clockwise
    const drawn = footprintFromCorners(corners, frame);
    expect(drawn.source).toBe('user');
    expect(drawn.id.startsWith('user/')).toBe(true);
    expect(ringArea(drawn.ring)).toBeGreaterThan(0);
    const fps = [drawn, target, across];
    const s = buildTileScene({ ...baseInput(), footprints: fps, targetId: drawn.id, camera: placeCamera(drawn, fps, []) });
    expect(s.targetBuildingId).toBe(drawn.id);
    expect(s.footprints.map((f) => f.id)).toEqual([drawn.id, across.id]);
    expect(s.dataSources.some((d) => d.name.includes('drawn'))).toBe(true);
    expect(() => footprintFromCorners(corners.slice(0, 2), frame)).toThrow();
  });

  it('solves nothing it cannot observe: without detections the camera stays as placed', () => {
    const r = prepareTileScene(baseInput());
    expect(r.aligned).toBe(false);
    expect(r.scene.camera.pitch).toBe(8);
    expect(r.scene.camera.provenance.pitch).toBe('assumed');
    const r2 = alignTileScene(r.scene);
    expect(r2.scene.camera).toEqual(r.scene.camera);
  });
});

describe('mergeManualCamera', () => {
  it('keeps only the fields the user corrected', () => {
    const base = buildTileScene(baseInput()).camera;
    const current: CameraParams = { ...base, position: [3, -30], heading: 10, pitch: 4, hfov: 70, provenance: { ...base.provenance, position: 'manual', pitch: 'inferred', hfov: 'manual' } };
    const m = mergeManualCamera(base, current);
    expect(m.position).toEqual([3, -30]);
    expect(m.provenance.position).toBe('manual');
    expect(m.hfov).toBe(70);
    expect(m.pitch).toBe(base.pitch);
    expect(m.heading).toBe(base.heading);
    expect(m.provenance.pitch).toBe('assumed');
  });
});

describe('parseLocationInput (local, no network)', () => {
  const cases: [string, number, number][] = [
    ['48.8460, 2.3727', 48.846, 2.3727],
    ['48.8460 2.3727', 48.846, 2.3727],
    ['40.7128° N, 74.0060° W', 40.7128, -74.006],
    ['geo:52.37163,4.88646?z=18', 52.37163, 4.88646],
    ['https://www.openstreetmap.org/#map=18/48.84600/2.37270', 48.846, 2.3727],
    ['https://www.openstreetmap.org/?mlat=52.3716&mlon=4.8865#map=19/52.3716/4.8865', 52.3716, 4.8865],
    ['https://www.google.com/maps/@48.8460,2.3727,17z', 48.846, 2.3727],
    ['https://www.google.com/maps/place/Foo/@48.84,2.37,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d48.8461!4d2.3728', 48.8461, 2.3728],
    ['https://maps.google.com/?q=48.8460,2.3727', 48.846, 2.3727],
    ['https://maps.apple.com/?ll=52.3716,4.8865&q=Pin', 52.3716, 4.8865],
    ['maps.apple.com/?coordinate=52.3716,4.8865', 52.3716, 4.8865],
  ];
  it.each(cases)('%s', (text, lat, lon) => {
    const p = parseLocationInput(text);
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(lat, 6);
    expect(p!.lon).toBeCloseTo(lon, 6);
  });
  it('returns null for addresses, out-of-range numbers and unresolvable short links', () => {
    expect(parseLocationInput('Herengracht 256 Amsterdam')).toBeNull();
    expect(parseLocationInput('95.0, 2.0')).toBeNull();
    expect(parseLocationInput('https://maps.app.goo.gl/AbCdEf')).toBeNull();
    expect(parseLocationInput('')).toBeNull();
  });
});

describe('footprint frames', () => {
  it('round-trips a drawn footprint through lon/lat', () => {
    const o: LatLon = { lat: 48.846, lon: 2.3727 };
    const ring = rect(-5, -5, 5, 5).map((p) => enuToLonLat(o, p));
    const f = footprintFromCorners(ring, o);
    const back = f.ring.map((p) => lonLatToEnu(o, enuToLonLat(o, p)));
    expect(back[0][0]).toBeCloseTo(f.ring[0][0], 6);
    expect(Math.abs(ringArea(f.ring))).toBeCloseTo(100, 2);
  });
});

describe('direction picker (facadeSides, cameraForSide, flip, fine heading)', () => {
  // Target: x 40..60 (20 m wide, E-W), y 0..10 (10 m deep). CCW ring: S edge, E edge, N edge, W edge.
  it('lists one side per facade with its compass label, clockwise from north', () => {
    const sides = facadeSides(target);
    expect(sides.map((s) => s.label)).toEqual(['N', 'E', 'S', 'W']);
    expect(sides.map((s) => Math.round(s.length))).toEqual([20, 10, 20, 10]);
    const south = sides.find((s) => s.label === 'S')!;
    expect(south.normal[0]).toBeCloseTo(0);
    expect(south.normal[1]).toBeCloseTo(-1);
  });

  it('works the same for a clockwise ring', () => {
    const cw = fp('omt/cw', target.ring.slice().reverse());
    expect(facadeSides(cw).map((s) => s.label)).toEqual(['N', 'E', 'S', 'W']);
  });

  it('merges a straight facade split by an extra vertex and drops short edges', () => {
    const split = fp('omt/split', [
      [0, 0],
      [10, 0],
      [20, 0.2], // nearly collinear: same south facade
      [20, 10],
      [20.5, 10.5], // a 0.7 m jog
      [0, 10.5],
    ]);
    const sides = facadeSides(split);
    const south = sides.filter((s) => s.label === 'S');
    expect(south).toHaveLength(1);
    expect(south[0].edges).toEqual([0, 1]);
    expect(south[0].length).toBeCloseTo(20, 0);
    expect(sides.every((s) => s.length >= 3)).toBe(true);
  });

  it('treats a short jog between two parallel parts as one facade', () => {
    // East facade: x = 20 for y 0..12, a 0.8 m step out, then x = 20.8 for y 12..20.
    const jogged = fp('omt/jog', [
      [0, 0],
      [20, 0],
      [20, 12],
      [20.8, 12],
      [20.8, 20],
      [0, 20],
    ]);
    const sides = facadeSides(jogged);
    const east = sides.filter((s) => s.label === 'E');
    expect(east).toHaveLength(1);
    expect(east[0].edges).toEqual([1, 2, 3]);
    expect(east[0].length).toBeCloseTo(20, 1); // the jog does not count
    expect(east[0].edge).toBe(1);
    expect(sides.map((s) => s.label)).toEqual(['N', 'E', 'S', 'W']);
  });

  it('keeps at most `max` of the longest sides', () => {
    const star: Vec2[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 ? 6 : 14;
      star.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    expect(facadeSides(fp('omt/star', star)).length).toBeLessThanOrEqual(6);
  });

  it('places the camera across the picked facade, looking at it (position assumed, heading inferred)', () => {
    const sides = facadeSides(target);
    const east = sides.find((s) => s.label === 'E')!;
    const cam = cameraForSide(east, [target, across], { targetId: target.id });
    expect(cam.position[0]).toBeCloseTo(75);
    expect(cam.position[1]).toBeCloseTo(5);
    expect(cam.heading).toBeCloseTo(270);
    expect(cam.provenance).toEqual({ position: 'assumed', heading: 'inferred' });
    expect(cam.basis).toBe('side');
    expect(currentSide(target, sides, cam)?.label).toBe('E');
    expect(describeDirection(cam.heading, east)).toBe('Photo looks west at the east facade.');
  });

  it('steps closer when the stand-off would be inside another building', () => {
    const sides = facadeSides(target);
    const south = sides.find((s) => s.label === 'S')!;
    // `across` spans y −40..−28, so 15 m south (y = −15) is free; a block at y −20..−10 is not.
    const block = fp('omt/block', rect(40, -20, 60, -10));
    const cam = cameraForSide(south, [target, block], { targetId: target.id });
    expect(cam.position[1]).toBeGreaterThan(-10);
    expect(cam.position[1]).toBeLessThan(0);
  });

  it('flips to the opposite side and builds a scene facing that facade', () => {
    const sides = facadeSides(target);
    const north = sides.find((s) => s.label === 'N')!;
    expect(oppositeSide(sides, north)?.label).toBe('S');
    expect(oppositeSide(sides, sides.find((s) => s.label === 'E')!)?.label).toBe('W');
    const cam = cameraForSide(north, [target, across], { targetId: target.id });
    const scene = buildTileScene(baseInput({ camera: cam }));
    // Back in the scene frame, the facade the camera looks at faces north.
    const t = scene.footprints.find((f) => f.id === scene.targetBuildingId)!;
    const sSides = facadeSides(t);
    expect(sSides.find((s) => s.edges.includes(scene.facadeEdgeIndex))?.label).toBe('N');
  });

  it('turns the camera by ±5° and marks the heading manual', () => {
    const cam = cameraForSide(facadeSides(target)[0], [], {});
    const l = turnCamera(cam, -5);
    expect(l.heading).toBeCloseTo(175);
    expect(l.provenance.heading).toBe('manual');
    expect(l.provenance.position).toBe('assumed');
    expect(turnCamera(turnCamera(l, 5), 5).heading).toBeCloseTo(185);
    expect(turnCamera({ ...cam, heading: 2 }, -5).heading).toBeCloseTo(357);
    expect(turnCamera(l, 5).notes.filter((n) => n.startsWith('Viewing direction set by you'))).toHaveLength(1);
  });

  it('labels bearings on an 8-point compass', () => {
    expect([0, 44, 46, 90, 135, 180, 225, 270, 315, 359].map(compassPoint)).toEqual(['N', 'NE', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N']);
  });
});

describe('direction picker on a U-shaped building (notch 12 m wide)', () => {
  const u = { id: 'omt/u', ring: [[0, 0], [40, 0], [40, 30], [26, 30], [26, 10], [14, 10], [14, 30], [0, 30]] as Vec2[], tags: {}, source: 'tiles' } as unknown as Parameters<typeof facadeSides>[0] & { id: string };
  const sides = facadeSides(u, { max: SIDE_CHIPS_MAX });
  it('offers every side, including the notch back wall', () => {
    expect(sides.some((s) => s.edges.includes(4))).toBe(true);
    expect(sides.some((s) => s.edges.includes(6))).toBe(true);
  });
  it('never puts the camera inside the target, and the camera sees the picked notch wall', () => {
    for (const edge of [3, 5]) {
      const side = sides.find((s) => s.edges.includes(edge))!;
      const cam = cameraForSide(side, [u], { targetId: u.id });
      expect(pointInRing(cam.position, u.ring)).toBe(false);
      expect(currentSide(u as never, sides, cam)?.edges).toContain(edge);
    }
  });
  it('keeps an observed GPS point that stands in front of the picked side', () => {
    const south = sides.find((s) => s.edges.includes(0))!;
    const cam = cameraForSide(south, [u], { targetId: u.id, gps: [20, -12] });
    expect(cam.position).toEqual([20, -12]);
    expect(cam.provenance.position).toBe('observed');
    const north = sides.find((s) => s.label === 'N')!;
    const moved = cameraForSide(north, [u], { targetId: u.id, gps: [20, -12] });
    expect(moved.provenance.position).toBe('assumed');
    expect(moved.notes.join(' ')).toMatch(/GPS point is not in front/);
  });
});
