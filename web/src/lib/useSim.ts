import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { reconstruct, type DepthSampler, type ReconstructionResult } from './reconstruct';
import { buildGeometry, type SimGeometry } from './obstacles';
import {
  annualKey,
  buildObstacleIndex,
  dailyExposure,
  evaluateWindowAt,
  localToUtc,
  runAnnualInWorker,
  sunSampleAt,
  sunTimes,
  type AnnualResult,
  type DailyExposureResult,
  type ObstacleIndex,
} from '../engine';
import type { DepthInfo, Scene } from '../schema/scene';
import { sceneViews } from './views';
import { defaultWindow, toWinLite } from './apartmentOps';
import type { SunSample, WindowSampleResult } from '../engine/types';

/* -------------------------------------------------------------------------- */
/* Depth                                                                       */
/* -------------------------------------------------------------------------- */

const depthCache = new Map<string, Promise<DepthSampler | null>>();

export function exampleBase(scene: Scene) {
  return scene.image.url.startsWith('blob:') || scene.image.url.startsWith('data:') ? '' : scene.image.url.replace(/[^/]*$/, '');
}

/** `base + url`, unless the url is already absolute or already starts with `base` (extra views' depth URLs are resolved by lib/examples.ts). */
function withBase(url: string, base: string) {
  if (!base || /^(https?:|blob:|data:|\/)/.test(url) || url.startsWith(base)) return url;
  return base + url;
}

export async function loadDepthArray(info: DepthInfo, base: string): Promise<Uint16Array | null> {
  try {
    if (info.binBase64) {
      const bin = atob(info.binBase64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new Uint16Array(buf.buffer);
    }
    if (info.binUrl) {
      const r = await fetch(withBase(info.binUrl, base));
      if (!r.ok) return null;
      return new Uint16Array(await r.arrayBuffer());
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function makeSampler(info: DepthInfo, arr: Uint16Array, imgW: number, imgH: number): DepthSampler {
  const sx = info.width / imgW;
  const sy = info.height / imgH;
  const k = (info.rawMax - info.rawMin) / 65535;
  return {
    width: info.width,
    height: info.height,
    sample(px, py) {
      const x = Math.floor(px * sx);
      const y = Math.floor(py * sy);
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) return null;
      // 3×3 median for robustness at edges
      const vals: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(info.width - 1, Math.max(0, x + dx));
          const yy = Math.min(info.height - 1, Math.max(0, y + dy));
          vals.push(arr[yy * info.width + xx]);
        }
      vals.sort((a, b) => a - b);
      return info.rawMin + vals[4] * k;
    },
  };
}

/** The depth maps of every photograph of a scene: the primary one and each extra view. */
function depthSources(scene: Scene) {
  const out: { viewId: string; info: DepthInfo; base: string; imgW: number; imgH: number }[] = [];
  if (scene.analysis.depth) out.push({ viewId: 'primary', info: scene.analysis.depth, base: exampleBase(scene), imgW: scene.image.width, imgH: scene.image.height });
  for (const v of scene.extraViews ?? []) {
    // Extra-view URLs are already resolved (lib/examples.ts) or inline (uploads).
    if (v.analysis.depth) out.push({ viewId: v.id, info: v.analysis.depth, base: '', imgW: v.image.width, imgH: v.image.height });
  }
  return out;
}

function loadSampler(scene: Scene, src: ReturnType<typeof depthSources>[number]) {
  const key = `${scene.id}#${src.viewId}#${src.info.binUrl ?? 'inline:' + (src.info.binBase64?.length ?? 0)}`;
  if (!depthCache.has(key))
    depthCache.set(
      key,
      loadDepthArray(src.info, src.base).then((a) => (a && a.length === src.info.width * src.info.height ? makeSampler(src.info, a, src.imgW, src.imgH) : null)),
    );
  return depthCache.get(key)!;
}

/** One depth sampler per view id ('primary' and extraViews[].id); views without a usable depth map are absent. */
export function useDepthSamplers(scene: Scene | null): Record<string, DepthSampler | null> {
  const [samplers, setSamplers] = useState<Record<string, DepthSampler | null>>({});
  const sourcesKey = scene ? depthSources(scene).map((s) => `${s.viewId}:${s.info.binUrl ?? 'inline'}`).join('|') : '';
  useEffect(() => {
    setSamplers({});
    if (!scene) return;
    let alive = true;
    for (const src of depthSources(scene)) {
      loadSampler(scene, src).then((s) => {
        if (alive && s) setSamplers((cur) => ({ ...cur, [src.viewId]: s }));
      });
    }
    return () => {
      alive = false;
    };
    // Re-load only when the scene or its set of depth maps changes (not on every camera edit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id, sourcesKey]);
  return samplers;
}

/** Depth sampler of the primary photograph. */
export function useDepthSampler(scene: Scene | null) {
  return useDepthSamplers(scene).primary ?? null;
}

/* -------------------------------------------------------------------------- */
/* Reconstruction + geometry                                                   */
/* -------------------------------------------------------------------------- */

export function useReconstruction(): { recon: ReconstructionResult; geo: SimGeometry; index: ObstacleIndex } | null {
  const scene = useStore((s) => s.scene);
  const camera = useStore((s) => s.camera);
  const detections = useStore((s) => s.detections);
  const viewCameras = useStore((s) => s.viewCameras);
  const viewDetections = useStore((s) => s.viewDetections);
  const settings = useStore((s) => s.settings);
  const overrides = useStore((s) => s.overrides);
  const trees = useStore((s) => s.trees);
  const extraBuildings = useStore((s) => s.extraBuildings);
  const selectedWindowIds = useStore((s) => s.selectedWindowIds);
  const apartment = useStore((s) => s.apartment);
  const depths = useDepthSamplers(scene);

  const views = useMemo(() => (scene ? sceneViews(scene, { camera, detections, viewCameras, viewDetections }) : []), [scene, camera, detections, viewCameras, viewDetections]);

  const recon = useMemo(() => {
    if (!scene || !camera) return null;
    return reconstruct({ scene, camera, detections, settings, overrides, depth: depths.primary ?? null, views, depths });
  }, [scene, camera, detections, settings, overrides, views, depths]);

  const geo = useMemo(() => {
    if (!scene || !recon || !camera) return null;
    return buildGeometry({ scene, recon, settings, trees, extraBuildings, selectedWindowIds, apartment, detections, camera, views });
  }, [scene, recon, settings, trees, extraBuildings, selectedWindowIds, apartment, detections, camera, views]);

  const index = useMemo(() => (geo ? buildObstacleIndex(geo.obstacles) : null), [geo]);
  // Stable identity: it is the SimContext value, so a new object would re-render every consumer.
  return useMemo(() => (recon && geo && index ? { recon, geo, index } : null), [recon, geo, index]);
}

/* -------------------------------------------------------------------------- */
/* Pending selection (landing → workspace)                                     */
/* -------------------------------------------------------------------------- */

export const PENDING_FALLBACK_NOTICE = "That window isn't on the modelled building, so we picked one on the same facade.";

/**
 * A sensible sample apartment: a window on the target facade, on the middle storey (median
 * of the floors ≥ 1, or the ground floor if that is all there is), near the middle of that
 * storey. Among the closest candidates the first one that gets at least half of the best
 * candidate's direct sun on `date` wins, so the sample shows sunlight when the facade gets
 * any. Deterministic. Returns null when the scene has no placed windows.
 */
export function pickSampleWindow(sim: { geo: SimGeometry; index: ObstacleIndex }, scene: Scene, date: string, maxCandidates = 8): string | null {
  const all = sim.geo.windows.map((w) => w.fw);
  if (!all.length) return null;
  let pool = all.filter((w) => w.buildingId === scene.targetBuildingId && w.edgeIndex === scene.facadeEdgeIndex);
  if (!pool.length) pool = all.filter((w) => w.buildingId === scene.targetBuildingId);
  if (!pool.length) pool = all;
  const floors = [...new Set(pool.map((w) => w.floor))].sort((a, b) => a - b);
  const upper = floors.filter((f) => f >= 1);
  const fl = upper.length ? upper : floors;
  const mid = fl[(fl.length - 1) >> 1];
  const midU = (f: number) => {
    const us = pool.filter((w) => w.floor === f).map((w) => w.u).sort((a, b) => a - b);
    return us[(us.length - 1) >> 1];
  };
  const centre = new Map(floors.map((f) => [f, midU(f)]));
  const ranked = [...pool].sort(
    (a, b) =>
      Math.abs(a.floor - mid) - Math.abs(b.floor - mid) ||
      (a.floor >= 1 ? 0 : 1) - (b.floor >= 1 ? 0 : 1) ||
      a.floor - b.floor ||
      Math.abs(a.u - centre.get(a.floor)!) - Math.abs(b.u - centre.get(b.floor)!) ||
      a.u - b.u ||
      a.id.localeCompare(b.id),
  );
  const cands = ranked.slice(0, maxCandidates);
  const specOf = new Map(sim.geo.windows.map((w) => [w.fw.id, w.spec]));
  const ctx = { lat: scene.origin.lat, lon: scene.origin.lon, tz: scene.timezone };
  const sun = cands.map((w) => {
    try {
      return dailyExposure(sim.index, [specOf.get(w.id)!], date, ctx, 10).aggregate.directMinutes;
    } catch {
      return 0;
    }
  });
  const best = Math.max(0, ...sun);
  if (best <= 0) return cands[0].id;
  const k = sun.findIndex((m) => m >= 0.5 * best);
  return cands[k >= 0 ? k : 0].id;
}

/**
 * Resolve store.pendingSelection against a reconstruction: 'auto' → apartmentOps.defaultWindow
 * (median upper floor of the target facade, closest to the median u: deterministic and not
 * biased towards sun); a detection id (or 'win-' + id) → that window when it was
 * placed, else the default window with `fellBack` set. pickSampleWindow is the fallback only
 * when the target building has no placed window at all.
 */
export function resolvePendingSelection(pending: 'auto' | string, sim: { geo: SimGeometry; index: ObstacleIndex }, scene: Scene, date: string): { windowId: string | null; fellBack: boolean } {
  const auto = () => defaultWindow(sim.geo.windows.map((w) => toWinLite(w.fw)), scene.targetBuildingId, scene.facadeEdgeIndex) ?? pickSampleWindow(sim, scene, date);
  if (pending !== 'auto') {
    const id = pending.startsWith('win-') ? pending : 'win-' + pending;
    if (sim.geo.windows.some((w) => w.fw.id === id)) return { windowId: id, fellBack: false };
    const alt = auto();
    return { windowId: alt, fellBack: alt != null };
  }
  return { windowId: auto(), fellBack: false };
}

/** Applies store.pendingSelection once the reconstruction of the current scene exists, then clears it. */
export function usePendingSelection(sim: ReturnType<typeof useReconstruction>) {
  const pending = useStore((s) => s.pendingSelection);
  const scene = useStore((s) => s.scene);
  const loading = useStore((s) => s.loading);
  const date = useStore((s) => s.date);
  useEffect(() => {
    if (pending == null || !sim || !scene || loading) return;
    const r = resolvePendingSelection(pending, sim, scene, date);
    useStore.setState({
      pendingSelection: null,
      ...(r.windowId ? { selectedWindowIds: [r.windowId], viewMode: 'exterior' as const } : {}),
      ...(r.fellBack ? { notice: { kind: 'info' as const, text: PENDING_FALLBACK_NOTICE } } : {}),
    });
  }, [pending, sim, scene, loading, date]);
}

/* -------------------------------------------------------------------------- */
/* Sun & exposure                                                              */
/* -------------------------------------------------------------------------- */

export function useSun(): { sun: SunSample; utc: number } | null {
  const scene = useStore((s) => s.scene);
  const date = useStore((s) => s.date);
  const minutes = useStore((s) => s.minutes);
  return useMemo(() => {
    if (!scene) return null;
    // Render-time code must not throw (a throw blanks the panel): a bad zone/date gives "no sun".
    try {
      const utc = localToUtc(date, minutes, scene.timezone);
      return { sun: sunSampleAt(utc, scene.origin.lat, scene.origin.lon), utc };
    } catch (e) {
      console.warn('[sunvisionai] sun position', e);
      return null;
    }
  }, [scene, date, minutes]);
}

export function useSunTimes() {
  const scene = useStore((s) => s.scene);
  const date = useStore((s) => s.date);
  return useMemo(() => {
    if (!scene) return null;
    try {
      return sunTimes(date, scene.origin.lat, scene.origin.lon, scene.timezone);
    } catch (e) {
      console.warn('[sunvisionai] sun times', e);
      return null;
    }
  }, [scene, date]);
}

/** Instantaneous evaluation of every placed window. */
export function useInstant(r: ReturnType<typeof useReconstruction>, sun: SunSample | undefined) {
  return useMemo(() => {
    const out: Record<string, WindowSampleResult> = {};
    if (!r || !sun) return out;
    for (const w of r.geo.windows) {
      try {
        out[w.fw.id] = evaluateWindowAt(r.index, w.spec, sun);
      } catch (e) {
        console.warn('[sunvisionai] window', w.fw.id, e); // left out rather than blanking the view
      }
    }
    return out;
  }, [r, sun]);
}

/** Daily exposure for the selected windows (or the full facade if nothing is selected). */
export function useDaily(r: ReturnType<typeof useReconstruction>, ids: string[]): DailyExposureResult | null {
  const scene = useStore((s) => s.scene);
  const date = useStore((s) => s.date);
  return useMemo(() => {
    if (!r || !scene) return null;
    const ws = r.geo.windows.filter((w) => ids.includes(w.fw.id)).map((w) => w.spec);
    if (!ws.length) return null;
    try {
      return dailyExposure(r.index, ws, date, { lat: scene.origin.lat, lon: scene.origin.lon, tz: scene.timezone }, 5);
    } catch (e) {
      console.warn('[sunvisionai] daily exposure', e);
      return null;
    }
  }, [r, scene, date, ids.join('|')]);
}

export function useAnnual(r: ReturnType<typeof useReconstruction>, ids: string[], enabled: boolean) {
  const scene = useStore((s) => s.scene);
  const date = useStore((s) => s.date);
  const [state, setState] = useState<{ result: AnnualResult | null; progress: number; running: boolean; error: string | null }>({ result: null, progress: 0, running: false, error: null });
  const reqRef = useRef(0);
  const year = Number(date.slice(0, 4));
  const input = useMemo(() => {
    if (!r || !scene || !ids.length) return null;
    const ws = r.geo.windows.filter((w) => ids.includes(w.fw.id)).map((w) => w.spec);
    if (!ws.length) return null;
    return { obstacles: r.geo.obstacles, windows: ws, ctx: { lat: scene.origin.lat, lon: scene.origin.lon, tz: scene.timezone }, options: { year, mode: 'weekly' as const, dayStep: 7, binMinutes: 15, keyDates: true } };
  }, [r, scene, ids.join('|'), year]);
  const key = input ? annualKey(input) : null;
  useEffect(() => {
    if (!enabled || !input) return;
    const id = ++reqRef.current;
    setState((s) => ({ ...s, running: true, progress: 0, error: null }));
    const t = setTimeout(() => {
      runAnnualInWorker(input, (d, n) => id === reqRef.current && setState((s) => ({ ...s, progress: d / n })))
        .then((result) => id === reqRef.current && setState({ result, progress: 1, running: false, error: null }))
        .catch((e) => id === reqRef.current && setState((s) => ({ ...s, running: false, error: String(e) })));
    }, 250);
    return () => clearTimeout(t);
  }, [key, enabled]);
  return state;
}
