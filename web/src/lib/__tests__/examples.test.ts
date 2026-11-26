/**
 * Reconstruction on the curated real-world examples, compared with independent
 * reference heights (3D BAG lidar, IGN BD TOPO, NYC DOITT …) recorded in
 * scene.validation. Writes docs/validation-results.json for the docs; asserts
 * only sanity bounds (we report errors, we don't tune to them).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DepthInfo, FacadeAnalysis, Scene } from '../../schema/scene';
import { reconstruct, type DepthSampler } from '../reconstruct';
import { defaultSettings, prepareScene, useStore } from '../../state/store';
import { sceneViews } from '../views';
import { buildGeometry } from '../obstacles';
import { buildObstacleIndex, dailyExposure } from '../../engine';

const EX = resolve(__dirname, '../../../public/examples');
/** Test-only fixture, not a published example (see fixtures/vilsonovo/README.md). */
const VILSONOVO = resolve(__dirname, 'fixtures/vilsonovo');
const ids = existsSync(EX) ? readdirSync(EX).filter((d) => existsSync(join(EX, d, 'scene.base.json')) && existsSync(join(EX, d, 'analysis.json'))) : [];

/** Scene + analysis from a folder holding scene.base.json and analysis.json (default: the published example). */
function load(id: string, dir = join(EX, id)): Scene {
  const s = JSON.parse(readFileSync(join(dir, 'scene.base.json'), 'utf8'));
  const a = JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8')) as FacadeAnalysis;
  return { ...s, analysis: a };
}

/** Depth sampler from a recorded depth16.bin (path relative to the example folder, or to `dir`). */
function depthFrom(id: string, d: DepthInfo | undefined, image: { width: number; height: number }, dir = join(EX, id)): DepthSampler | null {
  if (!d?.binUrl || !existsSync(join(dir, d.binUrl))) return null;
  const buf = readFileSync(join(dir, d.binUrl));
  const arr = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const sx = d.width / image.width;
  const sy = d.height / image.height;
  const k = (d.rawMax - d.rawMin) / 65535;
  return {
    width: d.width,
    height: d.height,
    sample(px, py) {
      const x = Math.floor(px * sx);
      const y = Math.floor(py * sy);
      if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
      return d.rawMin + arr[y * d.width + x] * k;
    },
  };
}

const depthFor = (s: Scene) => depthFrom(s.id, s.analysis.depth, s.image);

const results: Record<string, unknown>[] = [];

describe.skipIf(!ids.length)('curated examples', () => {
  for (const id of ids) {
    it(`${id}: reconstructs a plausible building and a working simulation`, () => {
      const s = load(id);
      const depth = depthFor(s);
      // The store's cameras: pitch solved when assumed, then auto-aligned from facade regularity (every view).
      const t0 = performance.now();
      const prepared = prepareScene(s);
      const prepareMs = performance.now() - t0;
      const cam = prepared.camera;
      const r0 = reconstruct({ scene: s, camera: s.camera, detections: s.analysis.detections, settings: defaultSettings, overrides: {}, depth });
      const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: defaultSettings, overrides: {}, depth });
      const mapOnly = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: { ...defaultSettings, heightMode: 'map-only' }, overrides: {} });
      // Multi-view: every extra photo with its own solved camera and depth map.
      const views = sceneViews(prepared, { camera: cam, detections: s.analysis.detections, viewCameras: {}, viewDetections: {} });
      const depths: Record<string, DepthSampler | null> = { primary: depth };
      for (const v of prepared.extraViews ?? []) depths[v.id] = depthFrom(id, v.analysis.depth, v.image);
      const rMV = reconstruct({ scene: prepared, camera: cam, detections: s.analysis.detections, settings: defaultSettings, overrides: {}, depth, views, depths });
      const t = r.buildings[s.targetBuildingId];
      expect(t.height.value).toBeGreaterThan(3);
      expect(t.height.value).toBeLessThan(120);
      const ref = s.validation?.find((v) => v.height != null);
      const refLv = s.validation?.find((v) => v.levels != null);
      // simulation smoke test on the target facade
      const g = buildGeometry({ scene: s, recon: r, settings: defaultSettings, trees: s.trees, extraBuildings: [], selectedWindowIds: [], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 0, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam });
      const wins = g.windows.filter((w) => w.fw.buildingId === s.targetBuildingId).map((w) => w.spec);
      const day = wins.length ? dailyExposure(buildObstacleIndex(g.obstacles), wins, '2025-06-21', { lat: s.origin.lat, lon: s.origin.lon, tz: s.timezone }, 10) : null;
      const gMV = buildGeometry({ scene: prepared, recon: rMV, settings: defaultSettings, trees: prepared.trees, extraBuildings: [], selectedWindowIds: [], apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 0, margin: 0.5, sillHeight: 0.9 }, detections: s.analysis.detections, camera: cam, views });
      const winsMV = gMV.windows.filter((w) => w.fw.buildingId === s.targetBuildingId).map((w) => w.spec);
      const dayMV = winsMV.length ? dailyExposure(buildObstacleIndex(gMV.obstacles), winsMV, '2025-06-21', { lat: s.origin.lat, lon: s.origin.lon, tz: s.timezone }, 10) : null;

      // ---- multi-view effect: which obstacles gained photo heights -----------------------------
      const fpOf = (bid: string) => s.footprints.find((f) => f.id === bid)!;
      const gained = Object.values(rMV.buildings)
        .filter((m) => m.reconstructedFrom === 'photo' && r.buildings[m.id].reconstructedFrom !== 'photo')
        .map((m) => ({
          id: m.id,
          views: (rMV.views ?? []).filter((v) => v.measuredBuildingIds.includes(m.id)).map((v) => v.id),
          height: +m.height.value.toFixed(2),
          low: +(m.height.low ?? NaN).toFixed(2),
          high: +(m.height.high ?? NaN).toFixed(2),
          singleViewHeight: +r.buildings[m.id].height.value.toFixed(2),
          singleViewSource: r.buildings[m.id].reconstructedFrom,
          osmHeight: fpOf(m.id).mapHeight ?? null,
          osmLevels: fpOf(m.id).mapLevels ?? null,
          floors: m.floors?.value ?? null,
          methods: m.methods?.filter((x) => x.used).map((x) => `${x.method}: ${x.value.toFixed(1)}`),
        }));
      const viewCams = (prepared.extraViews ?? []).map((v) => {
        const orig = s.extraViews!.find((o) => o.id === v.id)!.camera;
        const rv = rMV.views!.find((x) => x.id === v.id)!;
        return {
          id: v.id,
          pitch: [orig.pitch, v.camera.pitch],
          heading: [orig.heading, +v.camera.heading.toFixed(2)],
          hfov: [orig.hfov, +v.camera.hfov.toFixed(2)],
          aligned: (v.camera.notes ?? []).some((n) => n.startsWith('Auto-aligned from facade regularity')),
          groundResidual: rv.groundResidual,
          windowsDetected: rv.windowsDetected,
          windowsPlaced: rv.windowsPlaced,
          duplicates: rv.duplicates,
          depthCalibrated: rv.depthCalibration != null,
          measured: rv.measuredBuildingIds,
        };
      });

      // sanity only (we report errors, we don't tune to them)
      const photoIds = (rr: typeof r) => Object.values(rr.buildings).filter((m) => m.reconstructedFrom === 'photo').map((m) => m.id);
      for (const bid of photoIds(r)) expect(photoIds(rMV)).toContain(bid);
      for (const m of Object.values(rMV.buildings)) {
        expect(Number.isFinite(m.height.value)).toBe(true);
        expect(m.height.value).toBeGreaterThan(0);
        expect(m.height.value).toBeLessThan(400);
      }
      expect(new Set(rMV.windows.map((w) => w.id)).size).toBe(rMV.windows.length);
      expect(rMV.buildings[s.targetBuildingId].height.value).toBeGreaterThan(3);
      expect(rMV.buildings[s.targetBuildingId].height.value).toBeLessThan(120);
      for (const w of rMV.windows) expect(w.z + w.height / 2).toBeLessThanOrEqual(rMV.buildings[w.buildingId].height.value + 1e-6);

      const row = {
        id,
        windowsDetected: s.analysis.detections.filter((d) => d.cls === 'window').length,
        windowsOnTargetFacade: wins.length,
        cameraFixture: { pitch: s.camera.pitch, heading: s.camera.heading, roll: s.camera.roll, hfov: s.camera.hfov, provenance: s.camera.provenance, hfovRange: s.camera.hfovRange ?? null },
        cameraStore: { pitch: cam.pitch, heading: +cam.heading.toFixed(2), roll: +cam.roll.toFixed(2), hfov: +cam.hfov.toFixed(2), position: cam.position.map((v) => +v.toFixed(2)), provenance: cam.provenance },
        cameraAutoAligned: (cam.notes ?? []).some((n) => n.startsWith('Auto-aligned from facade regularity')),
        prepareSceneMs: Math.round(prepareMs),
        pitchInitial: s.camera.pitch,
        pitchCalibrated: cam.pitch,
        groundResidualInitial: r0.groundResidual,
        groundResidual: r.groundResidual,
        heightInitialCamera: +r0.buildings[s.targetBuildingId].height.value.toFixed(2),
        height: +t.height.value.toFixed(2),
        low: +(t.height.low ?? NaN).toFixed(2),
        high: +(t.height.high ?? NaN).toFixed(2),
        floors: t.floors?.value,
        floorHeight: +(t.floorHeight?.value ?? NaN).toFixed(2),
        methods: t.methods?.map((m) => ({ method: m.method, value: +m.value.toFixed(2), used: m.used, weight: +m.weight.toFixed(2) })),
        heightNote: t.height.note,
        mapOnlyHeight: +mapOnly.buildings[s.targetBuildingId].height.value.toFixed(2),
        mapOnlySource: mapOnly.buildings[s.targetBuildingId].reconstructedFrom,
        reference: ref ? { source: ref.source, height: ref.height } : null,
        error: ref ? +(t.height.value - ref.height!).toFixed(2) : null,
        errorInitialCamera: ref ? +(r0.buildings[s.targetBuildingId].height.value - ref.height!).toFixed(2) : null,
        referenceLevels: refLv ? { source: refLv.source, levels: refLv.levels } : null,
        juneSolsticeDirectMinutesFacadeMean: day ? Math.round(day.aggregate.directMinutes) : null,
        multiView: {
          views: viewCams,
          targetHeight: +rMV.buildings[s.targetBuildingId].height.value.toFixed(2),
          photoBuildingsSingle: photoIds(r).length,
          photoBuildingsMulti: photoIds(rMV).length,
          gainedPhotoHeights: gained,
          windowsPlaced: rMV.windows.length,
          juneSolsticeDirectMinutesFacadeMean: dayMV ? Math.round(dayMV.aggregate.directMinutes) : null,
        },
        depthCalibration: r.depthCalibration,
        // set aside by depth discontinuity (a building behind the facade; reconstruct.ts depthBackground)
        behindFacade: (rMV.views ?? []).map((v) => ({ view: v.id, rooflineSamples: v.rooflineBehindFacade, windows: v.windowsBehindFacade })).filter((v) => v.rooflineSamples || v.windows),
        warnings: r.warnings,
        warningsMultiView: rMV.warnings,
      };
      results.push(row);
    }, 60000);
  }
  it('Vilsonovo fixture: the Parliament tower behind the block is set aside by depth (guards against a known detection error)', () => {
    // Scene sarajevo-vilsonovo, a test fixture (fixtures/vilsonovo/README.md).
    // RF-DETR's facade mask swallows the tower far behind the block and marks one "window" on it
    // (box ≈ 677,112–695,177 px). The depth map puts both ≈ 3× farther than the facade. Not a
    // tuning target: there is no height reference in metres; the bounds below are what the photo
    // itself shows (roofline left and right of the tower 17.4–18.2 m; window rows at 2.2–16.4 m).
    const s = load('sarajevo-vilsonovo', VILSONOVO);
    const cam = prepareScene(s).camera;
    const r = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: defaultSettings, overrides: {}, depth: depthFrom(s.id, s.analysis.depth, s.image, VILSONOVO) });
    const t = r.buildings[s.targetBuildingId];
    const towerWin = s.analysis.detections.find((d) => d.cls === 'window' && Math.abs(d.bbox[0] - 677) < 3 && Math.abs(d.bbox[1] - 112) < 3)!;
    expect(towerWin).toBeDefined();
    expect(r.windows.some((w) => w.detectionId === towerWin.id)).toBe(false);
    expect(r.views![0].windowsBehindFacade).toBe(1);
    expect(r.views![0].rooflineBehindFacade).toBeGreaterThanOrEqual(8);
    // every roofline sample set aside lies over the tower (image x ≈ 560–1030 px)
    for (const h of r.rooflineHits.filter((q) => q.behind)) {
      expect(h.x).toBeGreaterThan(540);
      expect(h.x).toBeLessThan(1050);
    }
    expect(t.floors?.value).toBe(5);
    expect(t.height.value).toBeGreaterThan(17);
    expect(t.height.value).toBeLessThan(19.5);
    const onTarget = r.windows.filter((w) => w.buildingId === s.targetBuildingId);
    expect(Math.max(...onTarget.map((w) => w.z))).toBeLessThan(18);
    expect(r.warnings.join(' ')).toMatch(/roofline samples and 1 window set aside: the depth map puts them about \d(\.\d)?× farther/);
    // without the depth map nothing changes: the tower still inflates the result
    const r0 = reconstruct({ scene: s, camera: cam, detections: s.analysis.detections, settings: defaultSettings, overrides: {} });
    expect(r0.buildings[s.targetBuildingId].floors?.value).toBe(6);
    expect(r0.buildings[s.targetBuildingId].height.value).toBeGreaterThan(21);
  }, 60000);
  it('store: loadScene solves every view camera; reset, auto-align and undo restore cameras', () => {
    const id = ids.includes('paris-boulevard-diderot') ? 'paris-boulevard-diderot' : ids[0];
    const s = load(id);
    const st = useStore.getState();
    st.loadScene(s);
    const a = useStore.getState();
    expect(a.scene!.camera).toEqual(a.camera);
    expect(a.camera).not.toBe(a.scene!.camera); // the reference is a separate copy
    expect(Object.keys(a.viewCameras).sort()).toEqual((s.extraViews ?? []).map((v) => v.id).sort());
    for (const v of a.scene!.extraViews ?? []) expect(a.viewCameras[v.id]).toEqual(v.camera);
    // an assumed pitch never survives loading when a ground line exists
    if (s.camera.provenance.pitch === 'assumed' && s.analysis.groundline?.length) expect(a.camera!.provenance.pitch).not.toBe('assumed');
    const ref = structuredClone(a.camera!);
    a.setCamera({ heading: ref.heading + 7 });
    expect(useStore.getState().camera!.provenance.heading).toBe('manual');
    useStore.getState().resetViewCamera('primary');
    expect(useStore.getState().camera).toEqual(ref);
    expect(useStore.getState().undoViewCamera('primary')).toBe(true);
    expect(useStore.getState().camera!.heading).toBeCloseTo(ref.heading + 7, 9);
    useStore.getState().resetViewCamera('primary');
    const v0 = s.extraViews?.[0];
    if (v0) {
      const before = structuredClone(useStore.getState().viewCameras[v0.id]);
      useStore.getState().setViewCamera(v0.id, { pitch: before.pitch + 3 });
      useStore.getState().resetViewCamera(v0.id);
      expect(useStore.getState().viewCameras[v0.id]).toEqual(before);
      const res = useStore.getState().autoAlignView(v0.id);
      expect(typeof res.changed).toBe('boolean');
      if (res.changed) {
        expect(useStore.getState().undoViewCamera(v0.id)).toBe(true);
        expect(useStore.getState().viewCameras[v0.id]).toEqual(before);
      }
    }
    // loading the solved scene again is stable (the solved cameras are not moved again)
    const again = prepareScene(useStore.getState().scene!);
    expect(Math.abs(again.camera.heading - ref.heading)).toBeLessThan(0.5);
    expect(Math.abs(again.camera.pitch - ref.pitch)).toBeLessThan(0.5);
  }, 60000);
  it('writes the validation report', () => {
    const out = resolve(__dirname, '../../../../docs/validation-results.json');
    writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), note: 'Produced by web/src/lib/__tests__/examples.test.ts from the recorded fixtures. Errors are reported, not tuned.', results }, null, 2));
    // eslint-disable-next-line no-console
    console.table(results.map((r) => ({ id: r.id, h0: r.heightInitialCamera, h: r.height, ref: (r.reference as { height?: number } | null)?.height, err: r.error, floors: r.floors, refLv: (r.referenceLevels as { levels?: number } | null)?.levels, pitch: r.pitchCalibrated, aligned: r.cameraAutoAligned, mapOnly: r.mapOnlyHeight, ms: r.prepareSceneMs })));
    // eslint-disable-next-line no-console
    console.table(
      results.flatMap((r) =>
        ((r.multiView as { gainedPhotoHeights: { id: string; views: string[]; height: number; singleViewHeight: number; singleViewSource: string; osmHeight: number | null; floors: number | null }[] }).gainedPhotoHeights).map((g) => ({
          example: r.id,
          building: g.id,
          views: g.views.join(','),
          photoH: g.height,
          before: `${g.singleViewHeight} (${g.singleViewSource})`,
          osmH: g.osmHeight,
          floors: g.floors,
        })),
      ),
    );
    // eslint-disable-next-line no-console
    console.table(results.flatMap((r) => (r.multiView as { views: Record<string, unknown>[] }).views.map((v) => ({ example: r.id, ...v, pitch: JSON.stringify(v.pitch), heading: JSON.stringify(v.heading), hfov: JSON.stringify(v.hfov), measured: (v.measured as string[]).join(',') }))));
  });
});
