/**
 * AddViewDialog: add a photograph of the surroundings as an extra view.
 *
 * 1. Drop a photo. EXIF GPS / heading / focal length are read locally; if our API answers,
 *    analysis (RF-DETR via /api/analyze) starts right away.
 * 2. Place it on a small SVG plan of the scene's own footprints (no tiles, no Overpass, works
 *    offline): click the building the photo shows, set the camera dot and drag the heading
 *    handle. The camera can be placed automatically across the nearest street
 *    (autoCameraForBuilding, lib/tiles.ts) or across the clicked facade.
 * 3. A PhotoView is appended with store.addExtraView. On API errors the view is still added
 *    with no detections (manual annotation) and a notice explains what happened.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import type { BuildingModel, CameraParams, FacadeAnalysis, Footprint, PhotoView, Provenance, Scene, Vec2 } from '../../schema/scene';
import { useStore } from '../../state/store';
import { Dot, Modal } from '../kit';
import { Btn } from '../ui';
import { useSimContext } from '../SimContext';
import { analyzePhoto, AnalyzeError, askForKey, KEY_DIALOG_CODES, noticeForError } from '../../lib/analyzeApi';
import { getKeyPrompt, getRoboflowKey, setKeyPrompt, subscribeRoboflowKeySaved } from '../../lib/roboflowKey';
import { autoCameraForBuilding, type Street } from '../../lib/tiles';
import { edgeOutwardNormal, ringIsCCW } from '../../lib/camera';
import { calibratePitch, type ViewGeometry } from '../../lib/reconstruct';
import { facingEdge, firstHit, pointInRing } from '../../lib/sceneBuilder';
import { lonLatToEnu } from '../../engine';
import { useApiAvailable } from './ViewStrip';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 15 * 1024 * 1024;
/** EXIF GPS further than this from the scene origin is not trusted for placement. */
const MAX_GPS_DISTANCE = 500;

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export function buildingLabel(fp: Pick<Footprint, 'id' | 'tags'> | undefined): string {
  if (!fp) return 'Building';
  const t = fp.tags ?? {};
  if (t.name) return t.name;
  if (t['addr:street'] && t['addr:housenumber']) return `${t['addr:street']} ${t['addr:housenumber']}`;
  if (t['addr:housenumber']) return `No. ${t['addr:housenumber']}`;
  return fp.id;
}

export type HeightSourceSnapshot = Record<string, BuildingModel['reconstructedFrom']>;

export function snapshotHeightSources(buildings: Record<string, BuildingModel>): HeightSourceSnapshot {
  return Object.fromEntries(Object.entries(buildings).map(([id, b]) => [id, b.reconstructedFrom]));
}

const PLAIN_SOURCE: Record<BuildingModel['reconstructedFrom'], string> = {
  photo: 'the photo',
  'map-tag': 'a map height tag',
  'map-levels': 'the map floor count',
  'assumed-default': 'a default guess',
  manual: 'your edit',
};

/**
 * The toast after adding a view, from a real before/after diff of where
 * each building's height comes from. Only buildings that switched to 'photo' count.
 */
export function heightSourceToast(before: HeightSourceSnapshot, after: HeightSourceSnapshot, labelOf: (id: string) => string): string {
  const changed = Object.keys(after).filter((id) => after[id] === 'photo' && before[id] !== 'photo');
  if (!changed.length) return "Photo added. It didn't change any building heights. Try one that shows the full facade.";
  return changed.map((id) => `${labelOf(id)}: height now from photo (was ${before[id] ? PLAIN_SOURCE[before[id]] : 'not modelled'}).`).join(' ');
}

/** Compass bearing (deg clockwise from north) of an ENU direction. */
const bearing = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

function nearestEdge(ring: Vec2[], p: Vec2): { edge: number; dist: number } {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2));
    const d = Math.hypot(a[0] + t * ex - p[0], a[1] + t * ey - p[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { edge: best, dist: bd };
}

/** Camera on the outward normal of edge `edge`, `dist` metres from its midpoint, facing it. */
export function cameraAcrossEdge(fp: Footprint, edge: number, dist: number): { position: Vec2; heading: number } {
  const a = fp.ring[edge];
  const b = fp.ring[(edge + 1) % fp.ring.length];
  const n = edgeOutwardNormal(a, b, ringIsCCW(fp.ring));
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { position: [mid[0] + n[0] * dist, mid[1] + n[1] * dist], heading: bearing(-n[0], -n[1]) };
}

/** Whether footprint edge `edge` faces the point `p` (outward normal towards it). */
function edgeFaces(fp: Footprint, edge: number, p: Vec2): boolean {
  const a = fp.ring[edge];
  const b = fp.ring[(edge + 1) % fp.ring.length];
  if (!a || !b) return false;
  const n = edgeOutwardNormal(a, b, ringIsCCW(fp.ring));
  return (p[0] - (a[0] + b[0]) / 2) * n[0] + (p[1] - (a[1] + b[1]) / 2) * n[1] > 0;
}

/** Buildings hit by 121 rays across the field of view (≤ 120 m), like scripts/add_views.py. */
export function visibleBuildings(footprints: Footprint[], position: Vec2, heading: number, hfov: number, exclude: string): string[] {
  const ids = new Set<string>();
  for (let i = 0; i <= 120; i++) {
    const h = heading - hfov / 2 + (hfov * i) / 120;
    const hit = firstHit(footprints, position, h);
    if (hit && hit.t <= 120 && hit.fp.id !== exclude) ids.add(hit.fp.id);
  }
  return [...ids];
}

/* ------------------------------------------------------------------------------------------ */
/* Component                                                                                    */
/* ------------------------------------------------------------------------------------------ */

interface Photo {
  file: File;
  url: string;
  width: number;
  height: number;
  gps?: { lat: number; lon: number };
  heading?: number;
  focal35?: number;
  focalMm?: number;
  captureTime?: string;
  make?: string;
  model?: string;
}

type AnalysisState = { status: 'idle' } | { status: 'running' } | { status: 'done'; analysis: FacadeAnalysis } | { status: 'failed'; error: unknown };

interface Placement {
  position: Vec2 | null;
  heading: number | null;
  posProv: Provenance;
  headProv: Provenance;
  targetId: string | null;
  edge: number | null;
  fromExif: boolean;
}

/** The camera you are placing (dot, heading handle, field of view): the selection blue, not the sun. */
const CAM = 'var(--color-accent)';

const EMPTY_PLACEMENT: Placement = { position: null, heading: null, posProv: 'assumed', headProv: 'assumed', targetId: null, edge: null, fromExif: false };

export default function AddViewDialog() {
  const open = useStore((s) => s.addViewOpen);
  const scene = useStore((s) => s.scene);
  const set = useStore((s) => s.set);
  const addExtraView = useStore((s) => s.addExtraView);
  const sim = useSimContext();
  const api = useApiAvailable();

  const [photo, setPhoto] = useState<Photo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [place, setPlace] = useState<Placement>(EMPTY_PLACEMENT);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const analysisRef = useRef<Promise<FacadeAnalysis> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keepUrlRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Toast after the reconstruction has re-run with the new view (real provenance diff).
  const pendingToast = useRef<{ before: HeightSourceSnapshot; recon: unknown } | null>(null);
  useEffect(() => {
    const p = pendingToast.current;
    if (!p || !sim || sim.recon === p.recon || !scene) return;
    pendingToast.current = null;
    const after = snapshotHeightSources(sim.recon.buildings);
    const fpById = new Map(scene.footprints.map((f) => [f.id, f]));
    set({ notice: { kind: 'info', text: heightSourceToast(p.before, after, (id) => buildingLabel(fpById.get(id))) } });
  }, [sim, scene, set]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    analysisRef.current = null;
    if (photo && !keepUrlRef.current) URL.revokeObjectURL(photo.url);
    keepUrlRef.current = false;
    setPhoto(null);
    setErr(null);
    setPlace(EMPTY_PLACEMENT);
    setAnalysis({ status: 'idle' });
    setBusy(false);
  };

  const close = () => {
    reset();
    set({ addViewOpen: false });
  };

  const startAnalysis = (f: File) => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setAnalysis({ status: 'running' });
    const pr = analyzePhoto(f, { depth: true, signal: ctl.signal }).then((a) => {
      const { privacy: _p, ...rest } = a;
      void _p;
      return rest as FacadeAnalysis;
    });
    analysisRef.current = pr;
    pr.then(
      (a) => !ctl.signal.aborted && setAnalysis({ status: 'done', analysis: a }),
      (e) => !ctl.signal.aborted && setAnalysis({ status: 'failed', error: e }),
    );
  };
  const startRef = useRef(startAnalysis);
  startRef.current = startAnalysis;

  // A key or quota error: once a (different) key is saved, detect this photo again by itself.
  const keyBlocked = analysis.status === 'failed' && analysis.error instanceof AnalyzeError && KEY_DIALOG_CODES.includes(analysis.error.code);
  useEffect(() => {
    if (!keyBlocked || !photo) return;
    // The key dialog (opened by analyzePhoto) can promise the automatic retry; "by hand" just closes it.
    const p = getKeyPrompt();
    if (p) setKeyPrompt({ ...p, autoRetry: true, onManual: () => {} });
    // An explicit save (even of the same key, e.g. after topping up credits) retries once.
    const unsub = subscribeRoboflowKeySaved(() => {
      if (!getRoboflowKey()) return;
      unsub();
      startRef.current(photo.file);
    });
    return unsub;
  }, [keyBlocked, photo]);

  const streets: Street[] = useMemo(() => (scene?.roads ?? []).map((r) => ({ id: r.id, line: r.line, tags: r.tags })), [scene]);

  if (!scene) return null;

  const hfovOf = (p: Photo | null) => (p?.focal35 ? (2 * Math.atan(36 / (2 * p.focal35)) * 180) / Math.PI : 60);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    if (!TYPES.includes(f.type)) return setErr('Please choose a JPG, PNG or WebP photograph.');
    if (f.size > MAX_BYTES) return setErr('This photo is larger than 15 MB.');
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      return setErr('This file could not be decoded as an image.');
    }
    let ex: Record<string, unknown> = {};
    try {
      // Loaded on demand: exifr is only needed once a photo is dropped.
      const { default: exifr } = await import('exifr');
      ex = (await exifr.parse(f, { gps: true, tiff: true, exif: true, translateValues: true })) ?? {};
    } catch {
      /* no EXIF */
    }
    const p: Photo = {
      file: f,
      url,
      width: img.naturalWidth,
      height: img.naturalHeight,
      gps: typeof ex.latitude === 'number' && typeof ex.longitude === 'number' ? { lat: ex.latitude as number, lon: ex.longitude as number } : undefined,
      heading: typeof ex.GPSImgDirection === 'number' ? (ex.GPSImgDirection as number) : undefined,
      focal35: typeof ex.FocalLengthIn35mmFormat === 'number' ? (ex.FocalLengthIn35mmFormat as number) : undefined,
      focalMm: typeof ex.FocalLength === 'number' ? (ex.FocalLength as number) : undefined,
      captureTime: ex.DateTimeOriginal ? String(ex.DateTimeOriginal) : undefined,
      make: typeof ex.Make === 'string' ? ex.Make : undefined,
      model: typeof ex.Model === 'string' ? ex.Model : undefined,
    };
    setPhoto(p);
    // Pre-fill the placement from EXIF when it lands inside this scene.
    let next: Placement = EMPTY_PLACEMENT;
    if (p.gps) {
      const enu = lonLatToEnu(scene.origin, p.gps);
      if (Math.hypot(enu[0], enu[1]) <= MAX_GPS_DISTANCE) {
        next = { ...next, position: enu, posProv: 'observed', fromExif: true };
        if (p.heading != null) next = { ...next, heading: p.heading, headProv: 'observed' };
      } else {
        setErr(`This photo's location data is ${Math.round(Math.hypot(enu[0], enu[1]))} m from this scene, so it was not used. Place the camera by hand.`);
      }
    }
    setPlace(next);
    // Start the analysis right away unless we already know our API is down.
    if (api !== false) startAnalysis(f);
  };

  const fpById = new Map(scene.footprints.map((f) => [f.id, f]));

  /** Pick the building (and facade edge) the photo shows; auto-place the camera if it isn't set. */
  const pickBuilding = (fp: Footprint, at: Vec2 | null) => {
    setPlace((pl) => {
      // A click within 3 m of a facade picks that facade; otherwise the facade facing the
      // camera (when placed) or the one facing the nearest street.
      const near = at ? nearestEdge(fp.ring, at) : null;
      let edge: number;
      if (near && near.dist <= 3) edge = near.edge;
      else if (pl.position && pl.heading != null) edge = facingEdge(fp, pl.position, pl.heading);
      else edge = autoCameraForBuilding(fp, streets, { others: scene.footprints }).facadeEdgeIndex;
      if (pl.position) {
        // Camera already placed: aim at the building unless the heading is known.
        const a = fp.ring[edge];
        const b = fp.ring[(edge + 1) % fp.ring.length];
        if (pl.heading == null) return { ...pl, targetId: fp.id, edge, heading: bearing((a[0] + b[0]) / 2 - pl.position[0], (a[1] + b[1]) / 2 - pl.position[1]), headProv: 'inferred' };
        return { ...pl, targetId: fp.id, edge };
      }
      const auto = autoCameraForBuilding(fp, streets, { others: scene.footprints });
      const c = auto.facadeEdgeIndex === edge ? { position: auto.position, heading: auto.heading } : cameraAcrossEdge(fp, edge, 20);
      return { ...pl, targetId: fp.id, edge, position: c.position, heading: c.heading, posProv: 'assumed', headProv: 'assumed', fromExif: false };
    });
  };

  const autoPlace = () => {
    const fp = place.targetId ? fpById.get(place.targetId) : null;
    if (!fp) return;
    const auto = autoCameraForBuilding(fp, streets, { others: scene.footprints });
    setPlace((pl) => ({ ...pl, edge: auto.facadeEdgeIndex, position: auto.position, heading: auto.heading, posProv: 'assumed', headProv: 'assumed', fromExif: false }));
  };

  const ready = !!photo && !!place.position && place.heading != null && !!place.targetId;

  const submit = async () => {
    if (!photo || !place.position || place.heading == null || !place.targetId) return;
    const fp = fpById.get(place.targetId)!;
    setBusy(true);
    const manual: FacadeAnalysis = {
      model: { provider: 'manual', modelId: 'manual-annotation' },
      imageWidth: photo.width,
      imageHeight: photo.height,
      detections: [],
      floorRows: [],
      warnings: ['No computer-vision analysis for this photo: add windows with "Add a missing window" and correct heights by hand.'],
      pipelineVersion: 'manual',
    };
    let an: FacadeAnalysis = manual;
    let failure: unknown = null;
    if (analysisRef.current) {
      try {
        an = await analysisRef.current;
      } catch (e) {
        failure = e;
      }
    } else failure = new Error('no-backend');

    const hfov = hfovOf(photo);
    const hfovObserved = !!photo.focal35;
    const edge = place.edge != null && edgeFaces(fp, place.edge, place.position) ? place.edge : facingEdge(fp, place.position, place.heading);
    const camera: CameraParams = {
      position: place.position,
      height: 1.6,
      heading: Math.round(place.heading * 10) / 10,
      pitch: 8,
      roll: 0,
      hfov: Math.round(hfov * 10) / 10,
      provenance: { position: place.posProv, heading: place.headProv, pitch: 'assumed', hfov: hfovObserved ? 'observed' : 'assumed', height: 'assumed' },
      hfovRange: hfovObserved ? [Math.max(20, hfov * 0.5), Math.min(110, hfov * 1.05)] : undefined,
      notes: [
        place.fromExif ? "Position from the photo's EXIF GPS." : place.posProv === 'assumed' ? 'Position placed automatically across from the facade; check the fit.' : 'Position placed by hand on the plan.',
        hfovObserved ? `Field of view from EXIF 35 mm-equivalent focal length (${photo.focal35} mm).` : 'Field of view assumed (60°): no focal length in the metadata.',
        'Pitch 8°, roll 0° and lens height 1.6 m assumed.',
      ],
    };
    const geom: ViewGeometry = {
      footprints: scene.footprints,
      targetBuildingId: fp.id,
      facadeEdgeIndex: edge,
      visibleBuildingIds: visibleBuildings(scene.footprints, place.position, camera.heading, camera.hfov, fp.id),
      image: { width: photo.width, height: photo.height },
      analysis: an,
    };
    if (an.detections.length) {
      const p = calibratePitch(geom, camera);
      if (p != null) {
        camera.pitch = Math.round(p * 10) / 10;
        camera.provenance = { ...camera.provenance, pitch: 'inferred' };
        camera.notes = [...(camera.notes ?? []), `Pitch solved to ${p.toFixed(1)}° so the detected facade ground line lies at street level (was 8°, assumed).`];
      }
    }
    const view: PhotoView = {
      id: 'photo-' + Date.now().toString(36),
      label: buildingLabel(fp),
      purpose: 'surroundings',
      image: {
        url: photo.url,
        width: photo.width,
        height: photo.height,
        exif: { gps: photo.gps, focalLength35mm: photo.focal35, focalLengthMm: photo.focalMm, heading: photo.heading, captureTime: photo.captureTime, make: photo.make, model: photo.model },
      },
      camera,
      analysis: an,
      targetBuildingId: fp.id,
      facadeEdgeIndex: edge,
      visibleBuildingIds: geom.visibleBuildingIds ?? [],
    };
    if (!failure && sim) pendingToast.current = { before: snapshotHeightSources(sim.recon.buildings), recon: sim.recon };
    keepUrlRef.current = true; // the view now owns the object URL
    addExtraView(view);
    if (failure) {
      // Key / quota problems keep their own copy (a key fixes them); everything else gets the
      // add-view fallback: the view is already added, so "retry" would not mean anything here.
      const keyNotice = failure instanceof AnalyzeError ? noticeForError(failure) : null;
      if (keyNotice?.action === 'roboflow-key') set({ notice: keyNotice });
      else set({ notice: { kind: 'warning', text: "Couldn't detect this photo automatically. Mark the roofline yourself in Advanced.", action: 'mark-windows' } });
    }
    close();
  };

  return (
    <Modal open={open} onClose={close} title="Add a photo of the surroundings" width={640}>
      {!photo ? (
        <div className="space-y-3">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onFile(e.dataTransfer.files?.[0]);
            }}
            className={clsx(
              'flex min-h-48 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-ink-950 p-6 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent',
              dragOver ? 'border-accent bg-selected' : 'border-ink-600 hover:border-ink-400',
            )}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="mb-1.5 text-ink-400">
              <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m3.5 14 4-4 3 3 2-2 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="13" cy="7.5" r="1.25" fill="currentColor" />
            </svg>
            <span className="text-xs font-medium text-paper">Drop a photo of the buildings across the street, or a neighbour</span>
            <span className="text-[11px] text-ink-400">JPG, PNG or WebP · up to 15 MB</span>
            <input ref={fileInputRef} type="file" accept={TYPES.join(',')} className="sr-only" aria-label="Choose a photo" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <p className="text-[11px] leading-4 text-ink-400">
            {api ? "Location data is read in your browser. The photo's metadata is removed, then it is sent through the sunvisionai API to Roboflow for window detection." : api === false ? "The analysis server isn't reachable, so you will mark windows by hand. Location data is read in your browser." : 'Checking the analysis server…'}
          </p>
          {err && <p className="text-xs text-danger-text" role="alert">{err}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <img src={photo.url} alt="The photo you added" className="h-14 w-20 shrink-0 rounded-md bg-ink-800 object-cover ring-1 ring-ink-700" />
            <div className="min-w-0 flex-1 space-y-0.5 pt-0.5 text-xs">
              <div className="truncate font-medium text-paper">{photo.file.name}</div>
              <AnalysisStatus
                state={analysis}
                api={api}
                onAddKey={() => {
                  if (analysis.status === 'failed' && analysis.error instanceof AnalyzeError) askForKey(analysis.error.code, { autoRetry: true, notice: false, onManual: () => {} });
                }}
              />
            </div>
            <Btn onClick={reset} className="shrink-0">
              Choose another
            </Btn>
          </div>

          <div className="-mx-4 border-t border-ink-700 px-4 pt-3">
            <p className="text-xs font-semibold text-paper">Where were you standing, and which way were you facing?</p>
            <p className="mt-0.5 text-[11px] leading-4 text-ink-400">{place.targetId ? 'Drag the dot to where you stood and the arrow to the direction you faced.' : 'Click the building this photo shows'}</p>
            {place.fromExif && <p className="mt-0.5 text-[11px] font-medium text-ink-200">From your photo's location data</p>}
          </div>

          <PlanView scene={scene} place={place} setPlace={setPlace} hfov={hfovOf(photo)} onPick={pickBuilding} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-300">
            <span>
              Building: <span className="text-paper">{place.targetId ? buildingLabel(fpById.get(place.targetId)) : '—'}</span>
            </span>
            {place.position && (
              <span className="inline-flex items-center gap-1.5">
                <Dot p={place.posProv} />
                {place.fromExif ? "Camera from your photo's location data" : place.posProv === 'manual' ? 'Camera placed by you' : 'Camera placed automatically (a guess)'}
              </span>
            )}
            <label className="inline-flex items-center gap-1.5">
              Facing
              <input
                type="number"
                min={0}
                max={359}
                step={1}
                value={place.heading == null ? '' : Math.round(place.heading)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setPlace((pl) => ({ ...pl, heading: ((v % 360) + 360) % 360, headProv: 'manual' }));
                }}
                className="num h-11 w-20 rounded-md bg-ink-800 px-2 text-base text-paper placeholder:text-ink-400 hover:ring-1 hover:ring-inset hover:ring-ink-600 focus-visible:outline-1 focus-visible:outline-accent sm:h-7 sm:w-16 sm:text-xs"
                aria-label="Facing direction in degrees clockwise from north"
              />
              °
              {place.heading != null && <Dot p={place.headProv} />}
            </label>
            <Btn kind="solid" disabled={!place.targetId} onClick={autoPlace} title="Put the camera across the nearest street, facing the building" className="ml-auto">
              Place across the street
            </Btn>
          </div>

          {err && <p className="text-xs text-danger-text" role="alert">{err}</p>}

          <div className="-mx-4 -mb-4 flex justify-end gap-2 border-t border-ink-700 px-4 py-3">
            <Btn onClick={close}>Cancel</Btn>
            <Btn kind="primary" disabled={!ready || busy} onClick={submit} className="px-3">
              {busy ? (analysis.status === 'running' ? 'Detecting windows…' : 'Adding…') : 'Add photo'}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AnalysisStatus({ state, api, onAddKey }: { state: AnalysisState; api: boolean | null; onAddKey: () => void }) {
  if (state.status === 'running') return <div className="text-ink-300" aria-live="polite">Detecting windows and facades with Roboflow RF-DETR…</div>;
  if (state.status === 'done') {
    const n = state.analysis.detections.filter((d) => d.cls === 'window').length;
    const f = state.analysis.detections.filter((d) => d.cls === 'facade').length;
    return (
      <div className="text-ink-300" aria-live="polite">
        Found <span className="num text-paper">{n}</span> window{n === 1 ? '' : 's'} and <span className="num text-paper">{f}</span> facade{f === 1 ? '' : 's'}.
      </div>
    );
  }
  if (state.status === 'failed') {
    const keyFix = state.error instanceof AnalyzeError && KEY_DIALOG_CODES.includes(state.error.code);
    return (
      <div className="text-danger-text" aria-live="polite">
        {state.error instanceof AnalyzeError ? noticeForError(state.error).text : "Couldn't detect this photo automatically."} You can still add it and mark windows by hand.
        {keyFix && (
          <span className="mt-1 flex flex-wrap items-center gap-2 text-ink-300">
            <Btn kind="primary" onClick={onAddKey}>
              Add my key
            </Btn>
            <span className="text-[11px]">Detection starts again by itself once the key is saved.</span>
          </span>
        )}
      </div>
    );
  }
  return <div className="text-ink-400">{api === false ? 'No analysis server: windows will be marked by hand.' : 'Waiting for the analysis server…'}</div>;
}

/* ------------------------------------------------------------------------------------------ */
/* Plan of the scene's footprints (SVG, ENU metres, north up)                                   */
/* ------------------------------------------------------------------------------------------ */

function PlanView({ scene, place, setPlace, hfov, onPick }: { scene: Scene; place: Placement; setPlace: (f: (p: Placement) => Placement) => void; hfov: number; onPick: (fp: Footprint, at: Vec2 | null) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<'camera' | 'heading' | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const fps = useMemo(() => scene.footprints.filter((f) => f.ring.some((p) => Math.hypot(p[0], p[1]) < 260)), [scene.footprints]);
  // Frame the neighbourhood that matters (≈ 80 m around the target and the existing cameras);
  // footprints further out are still drawn up to the edge of the frame.
  const box = useMemo(() => {
    const near = (p: Vec2) => Math.hypot(p[0], p[1]) < 80;
    const pts: Vec2[] = fps.flatMap((f) => f.ring.filter(near));
    pts.push(scene.camera.position, [0, 0]);
    for (const v of scene.extraViews ?? []) if (near(v.camera.position)) pts.push(v.camera.position);
    let x0 = Math.min(...pts.map((p) => p[0]));
    let x1 = Math.max(...pts.map((p) => p[0]));
    let y0 = Math.min(...pts.map((p) => p[1]));
    let y1 = Math.max(...pts.map((p) => p[1]));
    const pad = Math.max(10, 0.08 * Math.max(x1 - x0, y1 - y0));
    x0 -= pad;
    x1 += pad;
    y0 -= pad;
    y1 += pad;
    return { x0, x1, y0, y1, ext: Math.max(x1 - x0, y1 - y0) };
  }, [fps, scene.camera.position, scene.extraViews]);

  const toWorld = (e: { clientX: number; clientY: number }): Vec2 | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, -p.y];
  };
  const pts = (ring: Vec2[]) => ring.map((p) => `${p[0]},${-p[1]}`).join(' ');
  const r = box.ext * 0.013;
  const arrowLen = box.ext * 0.09;
  const head = place.heading ?? 0;
  const hv: Vec2 = [Math.sin((head * Math.PI) / 180), Math.cos((head * Math.PI) / 180)];
  const handle: Vec2 | null = place.position ? [place.position[0] + hv[0] * arrowLen, place.position[1] + hv[1] * arrowLen] : null;

  const onBackground = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag) return;
    const w = toWorld(e);
    if (!w) return;
    const hitFp = fps.find((f) => pointInRing(w, f.ring));
    if (hitFp) return onPick(hitFp, w);
    setPlace((pl) => {
      const next: Placement = { ...pl, position: w, posProv: 'manual', fromExif: false };
      if (pl.targetId && pl.headProv !== 'observed' && pl.headProv !== 'manual') {
        const fp = scene.footprints.find((f) => f.id === pl.targetId);
        if (fp && pl.edge != null) {
          const a = fp.ring[pl.edge];
          const b = fp.ring[(pl.edge + 1) % fp.ring.length];
          next.heading = bearing((a[0] + b[0]) / 2 - w[0], (a[1] + b[1]) / 2 - w[1]);
          next.headProv = 'inferred';
        }
      }
      return next;
    });
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const w = toWorld(e);
    if (!w) return;
    if (drag === 'camera') setPlace((pl) => ({ ...pl, position: w, posProv: 'manual', fromExif: false }));
    else setPlace((pl) => (pl.position ? { ...pl, heading: bearing(w[0] - pl.position[0], w[1] - pl.position[1]), headProv: 'manual' } : pl));
  };

  const keyCamera = (e: ReactKeyboardEvent) => {
    const s = e.shiftKey ? 5 : 1;
    const d: Record<string, Vec2> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] };
    if (!d[e.key]) return;
    e.preventDefault();
    setPlace((pl) => (pl.position ? { ...pl, position: [pl.position[0] + d[e.key][0], pl.position[1] + d[e.key][1]], posProv: 'manual', fromExif: false } : pl));
  };
  const keyHeading = (e: ReactKeyboardEvent) => {
    const s = e.shiftKey ? 10 : 2;
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -s : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? s : 0;
    if (!d) return;
    e.preventDefault();
    setPlace((pl) => ({ ...pl, heading: (((pl.heading ?? 0) + d) % 360 + 360) % 360, headProv: 'manual' }));
  };

  // Field-of-view wedge
  const wedge = (() => {
    if (!place.position || place.heading == null) return null;
    const L = box.ext * 0.35;
    const a0 = ((place.heading - hfov / 2) * Math.PI) / 180;
    const a1 = ((place.heading + hfov / 2) * Math.PI) / 180;
    const p = place.position;
    return `M${p[0]},${-p[1]} L${p[0] + Math.sin(a0) * L},${-(p[1] + Math.cos(a0) * L)} A${L},${L} 0 0 1 ${p[0] + Math.sin(a1) * L},${-(p[1] + Math.cos(a1) * L)} Z`;
  })();

  return (
    <svg
      ref={svgRef}
      viewBox={`${box.x0} ${-box.y1} ${box.x1 - box.x0} ${box.y1 - box.y0}`}
      preserveAspectRatio="xMidYMid meet"
      className={clsx('h-[240px] w-full touch-none select-none rounded-lg bg-ink-950 ring-1 ring-inset ring-ink-700 sm:h-[300px]', drag ? 'cursor-grabbing' : 'cursor-crosshair')}
      role="group"
      aria-label="Plan of the buildings in this scene. Click a building to pick it, click the ground to place the camera."
      onPointerDown={onBackground}
      onPointerMove={onMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {(scene.roads ?? []).map((rd) => (
        <polyline key={rd.id} points={pts(rd.line)} fill="none" stroke="var(--color-ink-600)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
      ))}
      {wedge && <path d={wedge} fill={CAM} fillOpacity={0.1} stroke={CAM} strokeOpacity={0.45} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
      {fps.map((f) => {
        const picked = f.id === place.targetId;
        const isTarget = f.id === scene.targetBuildingId;
        return (
          <polygon
            key={f.id}
            points={pts(f.ring)}
            tabIndex={0}
            role="button"
            aria-label={`${buildingLabel(f)}${isTarget ? ' (your building)' : ''}${picked ? ', selected' : ''}`}
            aria-pressed={picked}
            onPointerEnter={() => setHover(f.id)}
            onPointerLeave={() => setHover((h) => (h === f.id ? null : h))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(f, null);
              }
            }}
            fill={picked ? 'var(--color-map)' : isTarget ? 'var(--color-ink-300)' : hover === f.id ? 'var(--color-ink-500)' : 'var(--color-ink-600)'}
            fillOpacity={picked ? 0.6 : isTarget ? 0.55 : 1}
            stroke={picked ? 'var(--color-map)' : isTarget ? 'var(--color-ink-300)' : 'var(--color-ink-500)'}
            strokeWidth={picked ? 2 : 1}
            vectorEffect="non-scaling-stroke"
            className="cursor-pointer outline-none focus-visible:stroke-accent focus-visible:[stroke-width:2px]"
          >
            <title>{buildingLabel(f)}</title>
          </polygon>
        );
      })}
      {/* picked facade edge */}
      {place.targetId &&
        place.edge != null &&
        (() => {
          const fp = scene.footprints.find((f) => f.id === place.targetId);
          if (!fp) return null;
          const a = fp.ring[place.edge];
          const b = fp.ring[(place.edge + 1) % fp.ring.length];
          return <line x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} stroke="var(--color-map)" strokeWidth={4} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
        })()}
      {/* existing cameras */}
      <circle cx={scene.camera.position[0]} cy={-scene.camera.position[1]} r={r * 0.7} fill="var(--color-ink-300)" pointerEvents="none">
        <title>Main photo camera</title>
      </circle>
      {(scene.extraViews ?? []).map((v) => (
        <circle key={v.id} cx={v.camera.position[0]} cy={-v.camera.position[1]} r={r * 0.6} fill="var(--color-ink-400)" pointerEvents="none">
          <title>{v.label}</title>
        </circle>
      ))}
      {place.position && handle && (
        <g>
          <line x1={place.position[0]} y1={-place.position[1]} x2={handle[0]} y2={-handle[1]} stroke={CAM} strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <circle
            cx={handle[0]}
            cy={-handle[1]}
            r={r * 0.8}
            fill="var(--color-knob)"
            stroke={CAM}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            tabIndex={0}
            role="slider"
            aria-label="Facing direction"
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={Math.round(head)}
            aria-valuetext={`${Math.round(head)} degrees`}
            className="cursor-grab outline-none focus-visible:stroke-paper focus-visible:[stroke-width:3px]"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              setDrag('heading');
            }}
            onKeyDown={keyHeading}
          />
          <circle
            cx={place.position[0]}
            cy={-place.position[1]}
            r={r}
            fill={CAM}
            stroke="var(--color-knob)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            tabIndex={0}
            role="button"
            aria-label="Camera position: drag, or move with the arrow keys"
            className="cursor-grab outline-none focus-visible:stroke-paper focus-visible:[stroke-width:3px]"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              setDrag('camera');
            }}
            onKeyDown={keyCamera}
          />
        </g>
      )}
      <text x={box.x1 - box.ext * 0.03} y={-box.y1 + box.ext * 0.06} fill="var(--color-ink-400)" fontSize={box.ext * 0.032} fontWeight={500} fontFamily="Inter, system-ui, sans-serif" textAnchor="end" pointerEvents="none">
        N ↑
      </text>
    </svg>
  );
}
