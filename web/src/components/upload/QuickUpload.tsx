/**
 * Quick upload flow: drop a photo → click the building → the 3D model.
 *
 *  1. Drop. EXIF is read locally (exifr). Detection (`analyzePhoto`, /api/analyze) starts at once,
 *     in parallel with picking, unless the user chose to mark windows by hand.
 *  2. Click the building (BuildingPicker): footprints from the basemap tiles, an automatic camera.
 *  3. Building: a progress list with real states. Overpass enrichment runs for at most 8 s and
 *     is merged only if it arrives; the scene is built by lib/tileBuildings.ts and loaded.
 *
 * Every failure has one primary action and none is a dead end. The demo's premise: when automatic
 * detection is impossible because a key is missing or used up, ask for the key right there.
 *  - Before spending a request, /api/health is checked (lib/analyzeApi `detectionCheck`): a shared
 *    key that is disabled, exhausted or absent, with no key of the user's, asks for a key at once.
 *  - Key / quota errors from /api/analyze ask the same way.
 *  - The key dialog opens in its "required" variant, and detection re-runs by itself once a key is
 *    saved (also after the workspace opened); "Mark windows by hand instead" is always offered.
 *  - An unreachable detection server is said plainly (a key would not help): retry or mark by hand.
 * No detection or height is invented.
 *
 * The analysis job lives at module level so that a late result (a retry after a key was saved,
 * or "Try again" in the workspace notice) still reaches the scene after this screen unmounted.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import exifr from 'exifr';
import clsx from 'clsx';
import { useStore } from '../../state/store';
import type { Detection, FacadeAnalysis, ImageInfo, Scene } from '../../schema/scene';
import { Wordmark } from '../ui';
import { Dot } from '../kit';
import KeyPill from '../roboflow/KeyPill';
import { setNoticeRetry } from '../NoticeBar';
import { AnalyzeError, analyzePhoto, askForKey, detectionCheck, fetchHealth, noticeForError, type ApiHealth } from '../../lib/analyzeApi';
import { getKeyPrompt, getRoboflowKey, hasRoboflowKey, setKeyPrompt, subscribeRoboflowKey, subscribeRoboflowKeySaved } from '../../lib/roboflowKey';
import { fetchOsmAround, type OsmElement } from '../../lib/osm';
import { AUTO_CAMERA_DISTANCE, alignTileScene, buildTileScene, countWindows, fovFromExif, manualAnalysis, mergeManualCamera, ringCentroid, type CameraPlacement, type TileSceneInput } from '../../lib/tileBuildings';
import { streetPerspective } from '../../lib/vanishing';
import { enuToLonLat } from '../../engine/geo';
import BuildingPicker, { MAP_CREDIT, PICK_COPY, type BuildingPickerHandle, type PickResult } from './BuildingPicker';
import DirectionControls from './DirectionControls';
import ModelCredit from '../photo/ModelCredit';

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

export const UPLOAD_COPY = {
  dropTitle: 'Drop a street photo of the building',
  choose: 'Choose a photo',
  dropSub: "JPG, PNG or WebP · up to 15 MB. The photo's location, if it has one, is read on your device and used to load map tiles around it (OpenFreeMap). Its metadata is removed before Roboflow analyses it.",
  browse: 'browse',
  skip: "Skip detection, I'll mark windows myself",
  reading: 'Reading photo…',
  cta: 'Build the 3D model',
  manual: 'Place the camera manually',
  steps: { photo: 'Reading photo', windows: 'Finding windows (Roboflow RF-DETR)', depth: 'Estimating depth', build: 'Building 3D' },
  overpass: 'Trees and street data unavailable. Buildings come from map tiles.',
  noBackend: "Automatic window detection isn't available here. Mark the windows yourself.",
  keyTitle: 'Add your free Roboflow key to detect windows automatically',
  keyRetry: 'Detection starts again by itself once the key is saved.',
  serverDown: "The detection server isn't reachable, so windows can't be found automatically. A Roboflow key wouldn't help here.",
  markByHand: 'Mark windows by hand instead',
  failed: 'Detection failed.',
  none: 'No windows found in this photo. Add them by dragging boxes.',
  skipped: 'Detection skipped. Mark the windows yourself by dragging a box over each one.',
} as const;

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Overpass enrichment budget (ms) for the build step. */
const OVERPASS_BUDGET_MS = 8000;
/** How long the pre-flight /api/health check may delay detection (ms); after that, just try. */
const HEALTH_BUDGET_MS = 4000;

/* ------------------------------------------------------------------ */
/* Photo + analysis job (module level, survives unmount)               */
/* ------------------------------------------------------------------ */

interface Photo {
  file: File;
  url: string;
  width: number;
  height: number;
  exif: NonNullable<ImageInfo['exif']>;
  headingRef?: string;
}

type AnalysisState =
  | { status: 'idle' }
  | { status: 'skipped' }
  | { status: 'running' }
  /** Detection is blocked until the user adds a key (`code`: why, e.g. shared_quota_exhausted). */
  | { status: 'needs-key'; code: string }
  | { status: 'done'; analysis: FacadeAnalysis }
  | { status: 'failed'; error: AnalyzeError };

interface Built {
  sceneId: string;
  input: TileSceneInput;
}

const job: {
  photo: Photo | null;
  state: AnalysisState;
  promise: Promise<AnalysisState> | null;
  ctl: AbortController | null;
  attempt: number;
  keyAtFailure: string | null;
  unsubKey: (() => void) | null;
  built: Built | null;
  /** The key dialog was already shown for this photo (the workspace then only sets the notice). */
  keyAsked: boolean;
} = { photo: null, state: { status: 'idle' }, promise: null, ctl: null, attempt: 0, keyAtFailure: null, unsubKey: null, built: null, keyAsked: false };

const jobListeners = new Set<() => void>();
const emit = () => jobListeners.forEach((l) => l());
const subscribeJob = (l: () => void) => {
  jobListeners.add(l);
  return () => jobListeners.delete(l);
};
function setJobState(s: AnalysisState) {
  job.state = s;
  emit();
}

/** What to do about detection in this state (null = nothing to decide: running, done, skipped). */
function gateOf(st: AnalysisState): ReturnType<typeof detectionCheck> | null {
  if (st.status === 'needs-key') return { gate: 'ask-key', code: st.code };
  if (st.status === 'failed') return detectionCheck(undefined, hasRoboflowKey(), st.error);
  return null;
}
const needsKey = (st: AnalysisState) => gateOf(st)?.gate === 'ask-key';
const keyCode = (st: AnalysisState) => gateOf(st)?.code ?? 'shared_key_unavailable';

function resetJob() {
  job.ctl?.abort();
  job.unsubKey?.();
  setNoticeRetry(null);
  if (getKeyPrompt()?.autoRetry) setKeyPrompt(null);
  job.keyAsked = false;
  job.photo = null;
  job.state = { status: 'idle' };
  job.promise = null;
  job.ctl = null;
  job.attempt++;
  job.keyAtFailure = null;
  job.unsubKey = null;
  job.built = null;
  emit();
}

/**
 * Detection with the pre-flight check: /api/health (bounded to HEALTH_BUDGET_MS) decides whether a
 * request can work at all. A missing / used-up shared key with no user key asks for a key before
 * any request is spent; an unreachable server is reported as such.
 */
function runDetection(): Promise<AnalysisState> {
  const photo = job.photo;
  if (!photo) return Promise.resolve(job.state);
  job.ctl?.abort();
  job.ctl = null;
  const attempt = ++job.attempt;
  setJobState({ status: 'running' });
  const p = (async (): Promise<AnalysisState> => {
    const health: ApiHealth | null | undefined = await Promise.race([fetchHealth(), new Promise<undefined>((r) => setTimeout(() => r(undefined), HEALTH_BUDGET_MS))]);
    if (attempt !== job.attempt || job.photo !== photo) return job.state; // superseded; latestAnalysis follows the newer promise
    const chk = detectionCheck(health, hasRoboflowKey());
    if (chk.gate === 'ok') return startAnalysis();
    const st: AnalysisState =
      chk.gate === 'ask-key'
        ? { status: 'needs-key', code: chk.code ?? 'shared_key_unavailable' }
        : { status: 'failed', error: new AnalyzeError(chk.code ?? 'api_unavailable', 0, chk.gate === 'server-down' ? "The sunvisionai detection server isn't reachable." : "This server can't run Roboflow detection.") };
    setJobState(st);
    onSettled(st);
    return st;
  })();
  job.promise = p;
  return p;
}

function startAnalysis(): Promise<AnalysisState> {
  const photo = job.photo;
  if (!photo) return Promise.resolve(job.state);
  job.ctl?.abort();
  const ctl = new AbortController();
  job.ctl = ctl;
  const attempt = ++job.attempt;
  setJobState({ status: 'running' });
  const p = analyzePhoto(photo.file, { depth: true, signal: ctl.signal }).then(
    (res): AnalysisState => {
      const { privacy: _privacy, ...analysis } = res;
      return { status: 'done', analysis };
    },
    (e: unknown): AnalysisState => {
      if (ctl.signal.aborted) return { status: 'skipped' };
      const err = e instanceof AnalyzeError ? e : new AnalyzeError('provider_error', 0, e instanceof Error ? e.message : String(e));
      return { status: 'failed', error: err };
    },
  );
  const tracked = p.then((st) => {
    if (attempt === job.attempt) {
      setJobState(st);
      onSettled(st);
    }
    return st;
  });
  job.promise = tracked;
  return tracked;
}

/** Wait for the newest analysis attempt (a retry may replace the one we started waiting for). */
async function latestAnalysis(): Promise<AnalysisState> {
  for (;;) {
    const p = job.promise;
    if (!p) return job.state;
    const st = await p;
    if (p === job.promise) return st;
  }
}

/**
 * Retry once automatically after a key/quota error when the user saves a key (explicitly: the
 * same key saved again counts, e.g. after topping up credits), or removes a key Roboflow rejected
 * (the pre-flight health check then decides between the shared key and asking again).
 */
function armKeyRetry() {
  job.keyAtFailure = getRoboflowKey();
  if (job.unsubKey) return;
  const retry = () => {
    job.unsubKey?.();
    job.unsubKey = null;
    const b = job.built;
    const s = useStore.getState();
    if (b && s.scene?.id === b.sceneId) s.set({ notice: { kind: 'info', text: 'Finding windows with your key (Roboflow RF-DETR)…' } });
    void runDetection();
  };
  const offSaved = subscribeRoboflowKeySaved(() => {
    if (!getRoboflowKey() || !needsKey(job.state)) return;
    retry();
  });
  const offChange = subscribeRoboflowKey(() => {
    // The user removed the key Roboflow rejected: no key needed if the shared allowance works.
    const st = job.state;
    if (getRoboflowKey() || st.status !== 'failed' || !st.error.code.startsWith('user_key_')) return;
    if (getKeyPrompt()?.autoRetry) setKeyPrompt(null);
    retry();
  });
  job.unsubKey = () => {
    offSaved();
    offChange();
  };
}

/**
 * The uploaded scene was left (another scene loaded, or back to the landing): disarm the retry and
 * drop the "required" prompt, so no hidden /api/analyze call runs for a photo that is gone.
 */
let abandonWatch: (() => void) | null = null;
function watchAbandon() {
  if (abandonWatch) return;
  abandonWatch = useStore.subscribe((s) => {
    const b = job.built;
    if (!b) return;
    if (s.scene?.id !== b.sceneId || s.route.name !== 'workspace') resetJob();
  });
}

/** "Mark windows by hand instead": stop waiting for a key or a retry. */
function chooseManual() {
  job.unsubKey?.();
  job.unsubKey = null;
  job.ctl?.abort();
  job.attempt++;
  setNoticeRetry(null);
  if (getKeyPrompt()?.autoRetry) setKeyPrompt(null);
  setJobState({ status: 'skipped' });
  const b = job.built;
  const s = useStore.getState();
  if (b && s.scene?.id === b.sceneId) s.set({ photoTool: 'add-window', notice: { kind: 'info', text: UPLOAD_COPY.skipped, action: 'mark-windows' } });
}

/** Ask for the key (required variant), with the auto-retry armed. `open`: show the dialog now. */
function askKeyFor(st: AnalysisState, open: boolean) {
  armKeyRetry();
  const code = keyCode(st);
  if (open) {
    job.keyAsked = true;
    askForKey(code, { autoRetry: true, onManual: chooseManual });
  } else {
    // The dialog was already shown for this photo: keep the prompt for the pill / notice button.
    askForKey(code, { autoRetry: true, onManual: chooseManual });
    useStore.getState().set({ keyDialogOpen: false });
  }
}

function onSettled(st: AnalysisState) {
  if (needsKey(st)) {
    // In the picker: ask right away. In the workspace, announceFailure does it (below).
    const b0 = job.built;
    const inWorkspace = !!b0 && useStore.getState().scene?.id === b0.sceneId;
    if (!inWorkspace) askKeyFor(st, true);
  } else if (st.status === 'done' && getKeyPrompt()?.autoRetry) setKeyPrompt(null);
  // After the scene was built, late results update the workspace in place.
  const b = job.built;
  const s = useStore.getState();
  if (!b || !s.scene || s.scene.id !== b.sceneId) return;
  if (st.status === 'done') applyLateAnalysis(b, st.analysis);
  else if (st.status === 'failed' || st.status === 'needs-key') announceFailure(st);
}

/** "Try again" (NoticeBar) — only meaningful while the uploaded scene is open. */
function retryFromNotice() {
  const b = job.built;
  const s = useStore.getState();
  if (!job.photo || !b || s.scene?.id !== b.sceneId) return;
  s.set({ notice: { kind: 'info', text: 'Finding windows (Roboflow RF-DETR)…' } });
  void runDetection();
}

/** The workspace is open and detection is not available: say why, with one action. */
function announceFailure(st: AnalysisState) {
  const s = useStore.getState();
  if (needsKey(st)) {
    s.set({ photoTool: 'add-window' });
    askKeyFor(st, !job.keyAsked);
    return;
  }
  if (st.status !== 'failed') return;
  const n = noticeForError(st.error);
  if (n.action === 'retry') setNoticeRetry(retryFromNotice);
  s.set({ notice: { kind: n.kind, text: n.text, action: n.action }, photoTool: 'add-window' });
}

/**
 * How the start camera is placed, in the words of the pick panel. For an oblique street photo the
 * build tries to look along the street from the photo's perspective (vanishing point of the window
 * rows) instead of straight at the facade, and keeps the start camera when that does not explain
 * the windows better (the camera notes then say so); a heading set or observed by hand is kept.
 */
function cameraBasisCopy(cam: Pick<CameraPlacement, 'basis' | 'provenance'>, oblique: boolean): string {
  const dirFromPhoto = oblique && cam.provenance.heading !== 'manual' && cam.provenance.heading !== 'observed';
  switch (cam.basis) {
    case 'gps':
      return dirFromPhoto ? "from GPS, direction from the photo's perspective where it fits" : 'from GPS';
    case 'manual':
      return dirFromPhoto ? "placed by you, direction from the photo's perspective where it fits" : 'placed by you';
    case 'side':
      return dirFromPhoto ? "along the side you picked, from the photo's perspective where it fits" : 'across the side you picked';
    default:
      return dirFromPhoto ? "along the main street, from the photo's perspective where it fits" : `${AUTO_CAMERA_DISTANCE} m in front of the facade`;
  }
}

/** Notice for a finished analysis in the workspace (null = nothing to say). */
function announceAnalysis(a: FacadeAnalysis, extraInfo: string | null) {
  const s = useStore.getState();
  if (countWindows(a) === 0) {
    s.set({ notice: { kind: 'warning', text: UPLOAD_COPY.none, action: 'mark-windows' }, photoTool: 'add-window' });
  } else {
    s.set({ pendingSelection: 'auto', notice: extraInfo ? { kind: 'info', text: extraInfo } : null });
  }
}

/** A detection result that arrived after the workspace opened: rebuild, keep the user's edits. */
function applyLateAnalysis(b: Built, analysis: FacadeAnalysis) {
  const s = useStore.getState();
  if (!s.scene) return;
  const keep = { overrides: s.overrides, extraBuildings: s.extraBuildings, settings: s.settings, date: s.date, minutes: s.minutes };
  const manual: Detection[] = s.detections.filter((d) => d.source === 'manual');
  const raw = buildTileScene({ ...b.input, analysis });
  const startCam = mergeManualCamera(raw.camera, s.camera);
  const { scene } = alignTileScene({ ...raw, camera: startCam });
  b.input = { ...b.input, analysis };
  s.loadScene(scene);
  const after = useStore.getState();
  after.set({ ...keep, detections: [...after.detections, ...manual] });
  announceAnalysis(analysis, null);
}

/* ------------------------------------------------------------------ */
/* Reading the photo                                                   */
/* ------------------------------------------------------------------ */

async function readPhoto(f: File): Promise<Photo> {
  if (!TYPES.includes(f.type)) throw new Error('Please choose a JPG, PNG or WebP photo.');
  if (f.size > MAX_BYTES) throw new Error('This photo is larger than 15 MB. Use a smaller copy.');
  const url = URL.createObjectURL(f);
  const img = new Image();
  try {
    // onload rather than decode(): decode() can stall in background tabs.
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This file couldn't be opened as an image. Try another photo.");
  }
  let ex: Record<string, unknown> = {};
  try {
    ex = ((await exifr.parse(f, { gps: true, tiff: true, exif: true, translateValues: true })) as Record<string, unknown> | undefined) ?? {};
  } catch {
    /* no EXIF */
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const lat = num(ex.latitude);
  const lon = num(ex.longitude);
  const gps = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? { lat, lon, ...(num(ex.GPSAltitude) != null ? { altitude: num(ex.GPSAltitude) } : {}) } : undefined;
  const capture = ex.DateTimeOriginal instanceof Date ? ex.DateTimeOriginal.toISOString() : ex.DateTimeOriginal ? String(ex.DateTimeOriginal) : undefined;
  const exif: NonNullable<ImageInfo['exif']> = {};
  if (gps) exif.gps = gps;
  if (num(ex.FocalLengthIn35mmFormat)) exif.focalLength35mm = num(ex.FocalLengthIn35mmFormat);
  if (num(ex.FocalLength)) exif.focalLengthMm = num(ex.FocalLength);
  if (num(ex.GPSImgDirection) != null) exif.heading = num(ex.GPSImgDirection);
  if (capture) exif.captureTime = capture;
  if (typeof ex.Make === 'string') exif.make = ex.Make;
  if (typeof ex.Model === 'string') exif.model = ex.Model;
  const ref = typeof ex.GPSImgDirectionRef === 'string' ? ex.GPSImgDirectionRef : undefined;
  if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
    URL.revokeObjectURL(url);
    throw new Error("This image has no size (0 × 0 pixels), so it can't be used. Try another photo.");
  }
  return { file: f, url, width: img.naturalWidth, height: img.naturalHeight, exif, headingRef: ref?.toUpperCase().startsWith('M') ? 'M' : ref ? 'T' : undefined };
}

/* ------------------------------------------------------------------ */
/* UI pieces                                                           */
/* ------------------------------------------------------------------ */

const linkBtn = 'rounded-sm font-medium text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent';
const secondaryBtn = 'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-selected aria-pressed:ring-accent pointer-coarse:h-11';
const primaryBase = 'inline-flex items-center justify-center gap-1.5 rounded-md bg-accent-500 px-3 text-xs font-medium text-on-accent hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11';
const primaryBtn = `${primaryBase} h-8`;
const primaryBtnSm = `${primaryBase} h-7`;
/** Text-style action that is still a 44 px target on touch screens. */
const textBase = 'inline-flex min-h-7 items-center rounded-md text-left hover:text-paper focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 pointer-coarse:min-h-11';
const textBtn = `${textBase} gap-1 text-xs text-ink-300`;

const iconProps = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
function ChevronRight() {
  return (
    <svg {...iconProps} width={12} height={12}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
function AlertIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={clsx('mt-px shrink-0', className)}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 11h.01" />
    </svg>
  );
}

function Header({ title, onHome }: { title?: string; onHome: () => void }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-3">
      <button type="button" className="flex min-h-7 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11" onClick={onHome} aria-label="sunvisionai home">
        <Wordmark size="sm" />
      </button>
      {title && (
        <>
          <div className="hidden h-4 w-px bg-ink-700 sm:block" />
          <h1 className="hidden truncate text-[13px] font-medium text-paper sm:block">{title}</h1>
        </>
      )}
      <div className="ml-auto">
        <KeyPill />
      </div>
    </header>
  );
}

/** The photo with detections drawn in as soon as they arrive. */
function Thumb({ photo, state }: { photo: Photo; state: AnalysisState }) {
  const a = state.status === 'done' ? state.analysis : null;
  const wins = a ? a.detections.filter((d) => d.cls === 'window' && !d.deleted) : [];
  const w = a?.imageWidth || photo.width;
  const h = a?.imageHeight || photo.height;
  return (
    <figure className="relative overflow-hidden rounded-lg bg-ink-950 ring-1 ring-ink-700">
      <img src={photo.url} alt="Your photo" className="block max-h-[30vh] w-full object-contain lg:max-h-none" />
      {a && (
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
          {wins.map((d) =>
            d.polygon && d.polygon.length > 2 ? (
              <polygon key={d.id} points={d.polygon.map((p) => p.join(',')).join(' ')} className="fill-accent/15 stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ) : (
              <rect key={d.id} x={d.bbox[0]} y={d.bbox[1]} width={d.bbox[2] - d.bbox[0]} height={d.bbox[3] - d.bbox[1]} className="fill-accent/15 stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ),
          )}
        </svg>
      )}
    </figure>
  );
}

function analysisLine(st: AnalysisState): { text: string; tone: 'muted' | 'ok' | 'warn' } {
  switch (st.status) {
    case 'idle':
    case 'running':
      return { text: 'Finding windows (Roboflow RF-DETR)…', tone: 'muted' };
    case 'skipped':
      return { text: "Detection skipped: you'll mark windows in the workspace.", tone: 'muted' };
    case 'done': {
      const n = countWindows(st.analysis);
      return n ? { text: `${n} window${n === 1 ? '' : 's'} found (Roboflow RF-DETR).`, tone: 'ok' } : { text: UPLOAD_COPY.none, tone: 'warn' };
    }
    case 'needs-key':
      return { text: noticeForError(new AnalyzeError(st.code, 0, st.code)).text, tone: 'warn' };
    case 'failed':
      return { text: noticeForError(st.error).text, tone: 'warn' };
  }
}

/**
 * Detection status in the side panel, with the one action that helps:
 * ask-key → "Add my key" (+ by hand), server-down / retry → "Try again" (+ by hand).
 */
function DetectionCallout({ state, onAddKey, onRetry, onManual }: { state: AnalysisState; onAddKey: () => void; onRetry: () => void; onManual: () => void }) {
  const line = analysisLine(state);
  const g = gateOf(state);
  if (!g) {
    return (
      <p role="status" className={clsx('flex gap-1.5 text-xs', line.tone === 'ok' || line.tone === 'warn' ? 'text-paper' : 'text-ink-300')}>
        {line.tone === 'warn' && <AlertIcon className="text-danger" />}
        <span>{line.text}</span>
      </p>
    );
  }
  if (g.gate === 'ask-key') {
    return (
      <div role="status" className="space-y-1.5 rounded-lg bg-selected p-3">
        <p className="text-xs font-semibold text-paper">{UPLOAD_COPY.keyTitle}</p>
        <p className="text-xs text-ink-200">{line.text}</p>
        <p className="text-[11px] text-ink-300">{UPLOAD_COPY.keyRetry}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <button type="button" className={primaryBtnSm} onClick={onAddKey}>
            Add my key
          </button>
          <button type="button" className={textBtn} onClick={onManual}>
            {UPLOAD_COPY.markByHand}
          </button>
        </div>
      </div>
    );
  }
  const text = g.gate === 'server-down' ? UPLOAD_COPY.serverDown : line.text;
  return (
    <div role="status" className="space-y-2 rounded-lg p-3 ring-1 ring-inset ring-ink-700">
      <p className="flex gap-1.5 text-xs text-paper">
        <AlertIcon className="text-danger" />
        <span>{text}</span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(g.gate === 'server-down' || g.gate === 'retry') && (
          <button type="button" className={secondaryBtn} onClick={onRetry}>
            Try again
          </button>
        )}
        <button type="button" className={textBtn} onClick={onManual}>
          {g.gate === 'manual' ? 'OK, I’ll mark windows by hand' : UPLOAD_COPY.markByHand}
        </button>
      </div>
    </div>
  );
}

type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

function StepRow({ label, state, detail }: { label: string; state: StepState; detail?: string }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        aria-hidden
        className={clsx(
          'grid h-4 w-4 shrink-0 place-items-center rounded-full',
          state === 'done' && 'bg-accent text-on-accent',
          state === 'running' && 'animate-spin border-[1.5px] border-ink-600 border-t-accent motion-reduce:animate-none',
          state === 'pending' && 'border-[1.5px] border-ink-600',
          (state === 'failed' || state === 'skipped') && 'bg-ink-700 text-ink-200',
        )}
      >
        {state === 'done' ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.25 5.25 4.25 7.25 7.75 3" />
          </svg>
        ) : state === 'failed' ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5 2.5v3M5 7.5h.01" />
          </svg>
        ) : state === 'skipped' ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 5h4" />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 -mt-px">
        <span className={clsx('block text-xs', state === 'pending' ? 'text-ink-400' : 'text-paper')}>
          {label}
          <span className="sr-only">: {state}</span>
        </span>
        {detail && <span className="block text-[11px] text-ink-400">{detail}</span>}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* QuickUpload                                                         */
/* ------------------------------------------------------------------ */

type Stage = 'drop' | 'reading' | 'pick' | 'building';

export default function QuickUpload({ onPlaceManually }: { onPlaceManually?: () => void }) {
  const set = useStore((s) => s.set);
  const [stage, setStage] = useState<Stage>('drop');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [skip, setSkip] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sel, setSel] = useState<PickResult | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pickStatus, setPickStatus] = useState<string | null>(null);
  const [buildStep, setBuildStep] = useState<StepState>('pending');
  const [buildErr, setBuildErr] = useState<string | null>(null);
  const [osmState, setOsmState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const fileInput = useRef<HTMLInputElement>(null);
  const picker = useRef<BuildingPickerHandle>(null);
  const analysis = useSyncExternalStore(subscribeJob, () => job.state, () => job.state);
  // An oblique street photo (window rows converging inside the frame): the build starts the camera
  // from its vanishing point instead of in front of the facade (lib/vanishing obliqueStart).
  const oblique = useMemo(
    () => (analysis.status === 'done' && photo ? streetPerspective(analysis.analysis.detections, { width: photo.width, height: photo.height }) !== null : false),
    [analysis, photo],
  );
  // Build-progress dialog: focus moves into it, and onto its action button whenever one appears.
  const buildDialog = useRef<HTMLDivElement>(null);
  const buildWaiting = stage === 'building' && (analysis.status === 'running' || analysis.status === 'idle');
  useEffect(() => {
    if (stage !== 'building') return;
    const el = buildDialog.current;
    if (el) (el.querySelector<HTMLElement>('button') ?? el).focus();
  }, [stage, buildErr, buildWaiting]);

  // A fresh visit starts a fresh job; the object URL is kept while a scene may still use it.
  useEffect(() => {
    resetJob();
    // A photo dropped on the landing arrives on the route; take it once.
    const r = useStore.getState().route;
    if (r.name === 'upload' && r.file) {
      const f = r.file;
      useStore.getState().set({ route: { name: 'upload' } });
      void onFile(f);
    }
    // Leaving the upload screen without building (home, an example, "Place the camera manually"):
    // abandon the job so no armed retry or "required" prompt outlives it.
    return () => {
      if (!job.built) resetJob();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (f: File | undefined | null) => {
    if (!f) return;
    setErr(null);
    setStage('reading');
    try {
      const p = await readPhoto(f);
      resetJob();
      job.photo = p;
      setPhoto(p);
      setSel(null);
      if (skip) setJobState({ status: 'skipped' });
      else void runDetection(); // in parallel with picking
      setStage('pick');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStage('drop');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void onFile(e.dataTransfer.files[0]);
  };

  const backToDrop = () => {
    resetJob();
    setPhoto(null);
    setSel(null);
    setDrawing(false);
    setStage('drop');
  };

  const dontWait = chooseManual;

  const build = async () => {
    if (!photo) return;
    setStage('building');
    setBuildErr(null);
    setBuildStep('pending');
    // Overpass enrichment, bounded to 8 s; never blocks the flow.
    const first = sel;
    const selTarget = first?.footprints.find((f) => f.id === first.targetId);
    let osmP: Promise<OsmElement[] | null> = Promise.resolve(null);
    if (first && selTarget && first.source === 'tiles') {
      const ctl = new AbortController();
      const centre = enuToLonLat(first.origin, ringCentroid(selTarget.ring));
      setOsmState('running');
      const timeout = new Promise<null>((r) => setTimeout(() => (ctl.abort(), r(null)), OVERPASS_BUDGET_MS));
      osmP = Promise.race([fetchOsmAround(centre, 200, ctl.signal).catch(() => null), timeout]).then((v) => {
        setOsmState(v && v.length ? 'done' : 'failed');
        return v && v.length ? v : null;
      });
    }
    try {
      const pick = (await picker.current?.finalize()) ?? sel;
      if (!pick) throw new Error('Select a building first.');
      const [st, osm] = await Promise.all([latestAnalysis(), osmP]);
      setBuildStep('running');
      await new Promise((r) => setTimeout(r, 30)); // let the list paint before the solver runs
      const analysisForScene =
        st.status === 'done'
          ? st.analysis
          : manualAnalysis(
              photo.width,
              photo.height,
              st.status === 'failed'
                ? `No computer-vision analysis (${st.error.code}): add windows with the window tool. sunvisionai does not invent geometry.`
                : st.status === 'needs-key'
                  ? `No computer-vision analysis yet (${st.code}): add your Roboflow key to detect windows, or add them with the window tool. sunvisionai does not invent geometry.`
                  : 'Detection skipped: add windows with the window tool. sunvisionai does not invent geometry.',
            );
      const input: TileSceneInput = {
        id: 'upload-' + Date.now(),
        title: photo.file.name,
        image: { url: photo.url, width: photo.width, height: photo.height, exif: photo.exif },
        analysis: analysisForScene,
        frameOrigin: pick.origin,
        footprints: pick.footprints,
        streets: pick.streets,
        targetId: pick.targetId,
        camera: pick.camera,
        osm,
      };
      const { scene } = alignTileScene(buildTileScene(input));
      job.built = { sceneId: scene.id, input };
      setBuildStep('done');
      finishBuild(scene, st, pick.source === 'tiles' && osm === null);
      watchAbandon();
    } catch (e) {
      setBuildStep('failed');
      setBuildErr(e instanceof Error ? e.message : String(e));
    }
  };

  const finishBuild = (scene: Scene, st: AnalysisState, overpassMissing: boolean) => {
    const s = useStore.getState();
    s.loadScene(scene); // clears the notice; set ours afterwards
    const info = overpassMissing ? UPLOAD_COPY.overpass : null;
    if (st.status === 'done') announceAnalysis(st.analysis, info);
    else if (st.status === 'failed' || st.status === 'needs-key') announceFailure(st);
    else useStore.getState().set({ notice: { kind: 'info', text: UPLOAD_COPY.skipped, action: 'mark-windows' }, photoTool: 'add-window' });
  };

  /* ---------------- render ---------------- */
  const home = () => {
    resetJob();
    set({ route: { name: 'landing' } });
  };

  if (stage === 'drop' || stage === 'reading') {
    return (
      <div className="flex h-full flex-col bg-ink-950">
        <Header onHome={home} />
        <main className="canvas-dots flex flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-3 p-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={clsx(
              'flex min-h-[280px] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center transition-colors duration-150',
              dragOver ? 'border-accent bg-selected ring-1 ring-accent' : 'border-ink-600 bg-ink-900 hover:border-ink-500',
            )}
          >
            {stage === 'reading' ? (
              <p role="status" className="flex items-center gap-2 text-xs text-ink-200">
                <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-ink-600 border-t-accent motion-reduce:animate-none" />
                {UPLOAD_COPY.reading}
              </p>
            ) : (
              <>
                <span aria-hidden className={clsx('grid h-10 w-10 place-items-center rounded-lg transition-colors', dragOver ? 'bg-accent text-on-accent' : 'bg-ink-800 text-ink-300')}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
                    <path d="m2.75 13.5 4-4 3.5 3.5 2.25-2.25 4.75 4.75" />
                    <circle cx="13" cy="7.75" r="1.25" />
                  </svg>
                </span>
                <h1 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-paper">{UPLOAD_COPY.dropTitle}</h1>
                {/* Phones cannot drop files: the button is the main way in, and works on desktop too. */}
                <button type="button" className={primaryBtn} onClick={() => fileInput.current?.click()}>
                  {UPLOAD_COPY.choose}
                </button>
                <p className="hidden text-xs text-ink-400 sm:block">
                  or drop it here, or{' '}
                  <button type="button" className={linkBtn} onClick={() => fileInput.current?.click()}>
                    {UPLOAD_COPY.browse}
                  </button>
                </p>
                <p className="max-w-[440px] pt-1 text-[11px] leading-4 text-ink-400">{UPLOAD_COPY.dropSub}</p>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose a photo"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          {err && (
            <p role="alert" className="flex gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger-text ring-1 ring-inset ring-danger/25">
              <AlertIcon />
              <span>{err}</span>
            </p>
          )}
          <div className="flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <button
              type="button"
              aria-pressed={skip}
              className={clsx(textBase, 'gap-2 text-xs text-ink-200')}
              onClick={() => {
                setSkip((v) => !v);
                if (!skip) fileInput.current?.click();
              }}
            >
              <span aria-hidden className={clsx('grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm transition-colors', skip ? 'bg-accent text-on-accent' : 'ring-1 ring-inset ring-ink-500')}>
                {skip && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.25 5.25 4.25 7.25 7.75 3" />
                  </svg>
                )}
              </span>
              {UPLOAD_COPY.skip}
              {skip && <span className="sr-only">(on)</span>}
            </button>
            {onPlaceManually && (
              <button type="button" className={textBtn} onClick={onPlaceManually}>
                {UPLOAD_COPY.manual}
                <ChevronRight />
              </button>
            )}
          </div>
          </div>
        </main>
      </div>
    );
  }

  if (!photo) return null;
  const target = sel?.footprints.find((f) => f.id === sel.targetId);
  const heightTag = target?.tags['sunvision:height_source'];
  const winState: StepState = analysis.status === 'done' ? 'done' : analysis.status === 'failed' || analysis.status === 'needs-key' ? 'failed' : analysis.status === 'skipped' ? 'skipped' : 'running';
  const hasDepth = analysis.status === 'done' && !!analysis.analysis.depth;
  const waitingForWindows = stage === 'building' && (analysis.status === 'running' || analysis.status === 'idle');
  const busy = stage === 'building';

  return (
    <div className="flex h-full flex-col bg-ink-950">
      {/* While the build-progress dialog is up, the page behind it is inert (no Tab to the logo, which would drop the analysis). */}
      <div className="contents" inert={busy}>
        <Header title={PICK_COPY.title} onHome={home} />
        {/* Phones: one scrolling column (map, then the panel) with the build button stuck to the bottom. Desktop: map | panel. */}
        <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
          {/* Phones: the map shrinks once a building is picked, so the side picker below it is in view. */}
          <section className={clsx('relative min-h-[300px] lg:h-auto lg:min-h-[420px]', sel ? 'h-[46vh]' : 'h-[56vh]', busy && 'pointer-events-none')} aria-busy={busy} aria-label={PICK_COPY.title}>
            <p className="sr-only">Pick the building you photographed on the map, then which side of it your photo shows.</p>
            <BuildingPicker
              photo={{ gps: photo.exif.gps, heading: photo.exif.heading, headingRef: photo.headingRef }}
              onChange={(p) => {
                setSel(p);
                // A successful pick supersedes an earlier "No building at the centre…" message.
                if (p) setPickStatus(null);
              }}
              drawing={drawing}
              onDrawingChange={setDrawing}
              handle={picker}
              onStatus={setPickStatus}
            />
          </section>
          <p className="bg-ink-950 px-3 py-1 text-[11px] leading-4 text-ink-400 lg:hidden">{MAP_CREDIT}</p>

          <aside className="flex flex-col border-t border-ink-700 bg-ink-900 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
            {/* "Which side?" first (in DOM and visual order), right under the map on phones, so it is
                in view before the sticky Build button is reached. */}
            {sel && <DirectionControls sel={sel} gps={photo.exif.gps} onCamera={(c) => picker.current?.setCamera(c)} disabled={busy || drawing} oblique={oblique} />}
            <div className="space-y-2 border-b border-ink-700 px-4 py-3">
            <Thumb photo={photo} state={analysis} />
            {analysis.status === 'done' && analysis.analysis.model.provider !== 'manual' && (
              <p className="-mt-1 text-[11px] leading-4 text-ink-400">
                <ModelCredit model={analysis.analysis.model} />
              </p>
            )}
            <DetectionCallout
              state={analysis}
              onAddKey={() => askKeyFor(analysis, true)}
              onRetry={() => void runDetection()}
              onManual={chooseManual}
            />
            </div>

            <div className="space-y-2 border-b border-ink-700 px-4 py-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px] leading-4">
              <dt className="text-ink-400">Location</dt>
              <dd className="flex items-center justify-end gap-1.5 text-right">
                {photo.exif.gps ? (
                  <>
                    <span className="num">
                      {photo.exif.gps.lat.toFixed(5)}, {photo.exif.gps.lon.toFixed(5)}
                    </span>
                    <Dot p="observed" />
                  </>
                ) : (
                  <span className="text-ink-400">no GPS in the photo</span>
                )}
              </dd>
              <dt className="text-ink-400">Field of view</dt>
              <dd className="flex items-center justify-end gap-1.5 text-right">
                {(() => {
                  const f = fovFromExif(photo.exif, photo.width, photo.height);
                  return (
                    <>
                      <span className="num">{f.hfov.toFixed(0)}°</span>
                      <span className="text-ink-400">{f.provenance === 'observed' ? `(${photo.exif.focalLength35mm} mm eq.)` : '(assumed)'}</span>
                      <Dot p={f.provenance} />
                    </>
                  );
                })()}
              </dd>
              {sel && target && (
                <>
                  <dt className="text-ink-400">Building</dt>
                  <dd className="flex items-center justify-end gap-1.5 text-right">
                    {sel.source === 'drawn' ? (
                      <>
                        <span>drawn by you</span>
                        <Dot p="manual" />
                      </>
                    ) : target.mapHeight != null ? (
                      <>
                        <span>
                          height <span className="num">{target.mapHeight}</span> m from map data{heightTag === 'openmaptiles:render_height' ? ' (rounded up)' : ''}
                        </span>
                        <Dot p="map" />
                      </>
                    ) : (
                      <span className="text-ink-400">no height in map data; measured from the photo</span>
                    )}
                  </dd>
                  <dt className="text-ink-400">Camera</dt>
                  <dd className="flex items-center justify-end gap-1.5 text-right">
                    <span>
                      {cameraBasisCopy(sel.camera, oblique)}
                    </span>
                    <Dot p={sel.camera.provenance.position} />
                  </dd>
                </>
              )}
            </dl>
            {sel && sel.camera.basis !== 'gps' && sel.camera.basis !== 'manual' && <p className="text-[11px] text-ink-400">{PICK_COPY.dragCam}</p>}
            {pickStatus && (
              <p role="status" className="flex gap-1.5 text-[11px] text-paper">
                <AlertIcon className="text-ink-300" />
                <span>{pickStatus}</span>
              </p>
            )}
            </div>

            <div className="flex flex-col items-start gap-1 px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={secondaryBtn} aria-pressed={drawing} onClick={() => setDrawing((d) => !d)} disabled={busy}>
                {drawing ? 'Stop drawing' : PICK_COPY.draw}
              </button>
              {onPlaceManually && (
                <button type="button" className={secondaryBtn} onClick={onPlaceManually} disabled={busy}>
                  {UPLOAD_COPY.manual}
                  <ChevronRight />
                </button>
              )}
            </div>
            <button type="button" className={clsx(textBase, 'text-[11px] text-ink-400')} onClick={backToDrop} disabled={busy}>
              Choose another photo
            </button>
            </div>

            {/* Primary action: sticky at the bottom of the screen on phones, at the panel's foot on desktop. */}
            <div className="sticky bottom-0 z-10 mt-auto border-t border-ink-700 bg-ink-900 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
              <button type="button" disabled={!sel || busy || drawing} onClick={() => void build()} className={clsx(primaryBtn, 'w-full')}>
                {UPLOAD_COPY.cta}
              </button>
              {!sel && <p className="mt-1.5 text-[11px] text-ink-400">Tap or click the photographed building on the map to continue.</p>}
            </div>
          </aside>
        </div>
      </div>

      {busy && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-scrim p-4">
          <div ref={buildDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sv-build-title" className="pop-in w-full max-w-sm rounded-xl bg-ink-900 text-paper shadow-panel outline-none">
            <h2 id="sv-build-title" className="flex h-11 items-center border-b border-ink-700 px-4 text-[13px] font-semibold">
              Building your model
            </h2>
            <div className="p-4 pt-2.5">
            <ol aria-live="polite">
              <StepRow label={UPLOAD_COPY.steps.photo} state="done" />
              <StepRow
                label={UPLOAD_COPY.steps.windows}
                state={winState}
                detail={analysis.status === 'done' ? `${countWindows(analysis.analysis)} windows` : analysis.status === 'needs-key' ? 'waiting for your Roboflow key: you can add it, or mark windows by hand' : analysis.status === 'failed' ? 'unavailable: you can mark windows by hand' : undefined}
              />
              {hasDepth && <StepRow label={UPLOAD_COPY.steps.depth} state="done" />}
              <StepRow label={UPLOAD_COPY.steps.build} state={buildStep === 'pending' ? 'pending' : buildStep} />
            </ol>
            {osmState === 'running' && <p className="mt-1.5 text-[11px] text-ink-400">Asking OpenStreetMap for trees and street names (at most 8 s)…</p>}
            {buildErr && (
              <div role="alert" className="mt-3 rounded-lg bg-danger/10 p-3 text-xs text-danger-text ring-1 ring-inset ring-danger/25">
                {buildErr}
                <button type="button" className={secondaryBtn + ' mt-2'} onClick={() => setStage('pick')}>
                  Back to the map
                </button>
              </div>
            )}
            {waitingForWindows && !buildErr && (
              <button type="button" className={secondaryBtn + ' mt-3'} onClick={dontWait}>
                Don't wait, I'll mark windows myself
              </button>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
