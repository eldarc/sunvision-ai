import { create } from 'zustand';
import type { CameraParams, Detection, ExtraBuilding, PhotoView, Scene, SceneSettings, Tree } from '../schema/scene';
import { calibrateViewCamera, hfovRangeFor, type BuildingOverride, type ViewGeometry } from '../lib/reconstruct';
import { autoAlignCamera } from '../lib/align';
import { facadePlane } from '../lib/camera';
import { recedingDirection, streetPerspective, vanishingAngleError, VP_REINIT_DEG } from '../lib/vanishing';
import { treesFromVegetation } from '../lib/vegetation';
import { clampDate } from '../engine/solar';

/** `upload.file`: a photo dropped on the landing, consumed once by QuickUpload. */
export type Route = { name: 'landing' } | { name: 'workspace' } | { name: 'upload'; file?: File };

export interface PhotoLayers {
  masks: boolean;
  boxes: boolean;
  labels: boolean;
  depth: boolean;
  floors: boolean;
  dims: boolean;
  alignment: boolean;
  classes: Record<string, boolean>;
}

export type ViewMode = 'overview' | 'street' | 'exterior' | 'interior' | 'top';
export type PhotoTool = 'select' | 'add-window' | 'delete';

export interface ApartmentParams {
  depth: number;
  ceilingHeight: number;
  balconyDepth: number;
  partitions: number;
  margin: number;
  /** Height of the window sill above the room floor (m). */
  sillHeight: number;
}

export interface Snapshot {
  label: string;
  directMinutes: number;
  windowIds: string[];
  date: string;
}

interface State {
  route: Route;
  scene: Scene | null;
  loading: string | null;
  error: string | null;
  camera: CameraParams | null;
  detections: Detection[];
  settings: SceneSettings;
  overrides: Record<string, BuildingOverride>;
  extraBuildings: ExtraBuilding[];
  trees: Tree[];
  selectedWindowIds: string[];
  hoveredWindowId: string | null;
  selectedBuildingId: string | null;
  apartment: ApartmentParams;
  snapshots: Snapshot[];
  date: string; // YYYY-MM-DD local to scene timezone
  minutes: number; // minutes since local midnight
  playing: boolean;
  speed: number; // simulated minutes per real second
  layers: PhotoLayers;
  viewMode: ViewMode;
  cutaway: boolean;
  photoTool: PhotoTool;
  showUncertainty: boolean;
  showSunPath: boolean;
  leftTab: 'photo' | 'map';
  /** 'simple' hides expert controls behind an "Advanced" switch. */
  uiMode: 'simple' | 'advanced';
  /** Which photograph the photo panel shows: 'primary' or an extraViews[].id. */
  activeViewId: string;
  /** Editable cameras / detections of extra views (keyed by view id). */
  viewCameras: Record<string, CameraParams>;
  viewDetections: Record<string, Detection[]>;
  /** Transient UI message (e.g. inference quota reached). */
  notice: { kind: 'info' | 'warning' | 'error'; text: string; action?: 'roboflow-key' | 'mark-windows' | 'add-view' | 'retry' } | null;
  keyDialogOpen: boolean;
  /** Window to select once reconstruction is ready ('auto' = pick a sensible sample apartment). */
  pendingSelection: 'auto' | string | null;
  /** Photo panel is in "drag corners to align" mode. */
  alignMode: boolean;
  addViewOpen: boolean;
  /** Shared Roboflow key allowance reported by /api/health (null = unknown / no API). */
  sharedQuota: { enabled: boolean; remaining: number | null; cap: number | null; resetsAt: string | null; exhausted: boolean } | null;
  setUiMode: (m: 'simple' | 'advanced') => void;
  /** Colour theme preference; 'system' follows prefers-color-scheme. Persisted. */
  themePreference: 'system' | 'light' | 'dark';
  setThemePreference: (t: 'system' | 'light' | 'dark') => void;
  /** Append a surroundings photo (already analysed, camera placed) to the current scene. */
  addExtraView: (v: import('../schema/scene').PhotoView) => void;
  removeExtraView: (id: string) => void;
  set: (p: Partial<State>) => void;
  /** Update the camera of any view ('primary' → `camera`). */
  setViewCamera: (viewId: string, p: Partial<CameraParams>, provenance?: Partial<CameraParams['provenance']>) => void;
  loadScene: (scene: Scene) => void;
  setCamera: (p: Partial<CameraParams>, provenance?: Partial<CameraParams['provenance']>) => void;
  setOverride: (id: string, o: Partial<BuildingOverride> | null) => void;
  toggleWindow: (id: string, additive: boolean) => void;
  updateDetection: (id: string, p: Partial<Detection> | null) => void;
  addDetection: (d: Detection) => void;
  /** Restore a view's camera to the reference solved on load ('primary' → scene.camera). Undoable. */
  resetViewCamera: (viewId: string) => void;
  /**
   * Re-run autoAlignCamera on a view's current camera (manual parameters stay fixed, FOV bounded
   * by hfovRangeFor). Applies the result when accepted, pushes the previous camera on the undo
   * stack, and returns the aligner's verdict for a toast.
   */
  autoAlignView: (viewId: string) => { changed: boolean; notes: string[]; spread0?: number; spread?: number };
  /** Previous cameras per view id, newest last (filled by autoAlignView / resetViewCamera). */
  cameraUndo: Record<string, CameraParams[]>;
  /** Pop the last camera of a view's undo stack. Returns false when there is nothing to undo. */
  undoViewCamera: (viewId: string) => boolean;
  /** Push a view's current camera on its undo stack (before a UI action replaces it). */
  pushCameraUndo: (viewId: string) => void;
}

/** The geometry of an extra view: the PhotoView plus the scene's shared footprints. */
function photoViewGeometry(scene: Scene, v: PhotoView): ViewGeometry {
  return { footprints: scene.footprints, targetBuildingId: v.targetBuildingId, facadeEdgeIndex: v.facadeEdgeIndex, visibleBuildingIds: v.visibleBuildingIds, image: v.image, analysis: v.analysis };
}

/**
 * Cameras as loadScene prepares them, for the primary photo and every extra view: an assumed
 * pitch is solved from the ground line, then autoAlignCamera refines every non-manual
 * parameter from facade regularity (FOV bounded by hfovRangeFor). Street trees seen in any
 * photo but missing from OSM are added from its vegetation detections. The returned scene
 * carries the solved cameras, which are the "Reset camera" reference.
 */
export function prepareScene(scene0: Scene): Scene {
  const cal = calibrateViewCamera(scene0, scene0.camera, scene0.analysis.detections);
  // An oblique street view re-initialised from its vanishing point also moves the facade edge.
  const scene: Scene = cal.view ? { ...scene0, ...cal.view } : scene0;
  const camera = cal.camera;
  const extraViews = scene.extraViews?.map((v) => {
    const c = calibrateViewCamera(photoViewGeometry(scene, v), v.camera, v.analysis.detections);
    return { ...v, ...(c.view ?? {}), camera: c.camera };
  });
  const vegTrees: Tree[] = [];
  vegTrees.push(...treesFromVegetation(scene, camera, scene.analysis.detections, [...scene.trees, ...vegTrees]));
  for (const v of extraViews ?? []) vegTrees.push(...treesFromVegetation(photoViewGeometry(scene, v), v.camera, v.analysis.detections, [...scene.trees, ...vegTrees]));
  return { ...scene, camera, ...(extraViews ? { extraViews } : {}), trees: [...scene.trees, ...vegTrees] };
}

/**
 * A hand edit marks the edited parameters manual so auto-alignment keeps them. Roll has no
 * provenance key of its own: it follows pitch (alignment.md §2.3), so a roll edit pins pitch.
 */
function markManual(prov: CameraParams['provenance'], p: Partial<CameraParams>) {
  for (const k of Object.keys(p) as (keyof CameraParams)[]) if (k in prov) (prov as Record<string, string>)[k] = 'manual';
  if ('roll' in p) prov.pitch = 'manual';
}

function initialThemePreference(): 'system' | 'light' | 'dark' {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('sv.theme') : null;
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function initialUiMode(): 'simple' | 'advanced' {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('advanced') === '1') return 'advanced';
    if (typeof localStorage !== 'undefined' && localStorage.getItem('sv.uiMode') === 'advanced') return 'advanced';
  } catch {
    /* storage unavailable */
  }
  return 'simple';
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const defaultSettings: SceneSettings = {
  heightMode: 'vision',
  defaultFloorHeight: 3.0,
  groundFloorExtra: 0.6,
  showNeighbors: true,
  showTrees: true,
  showBalconies: true,
  scenario: 'best',
  regularizeWindows: true,
};

export const useStore = create<State>((set, get) => ({
  route: { name: 'landing' },
  scene: null,
  loading: null,
  error: null,
  camera: null,
  detections: [],
  settings: defaultSettings,
  overrides: {},
  extraBuildings: [],
  trees: [],
  selectedWindowIds: [],
  hoveredWindowId: null,
  selectedBuildingId: null,
  apartment: { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 1, margin: 0.8, sillHeight: 0.9 },
  snapshots: [],
  date: today(),
  minutes: 14 * 60,
  playing: false,
  speed: 60,
  layers: { masks: true, boxes: false, labels: true, depth: false, floors: true, dims: false, alignment: false, classes: {} },
  viewMode: 'exterior',
  cutaway: false,
  photoTool: 'select',
  showUncertainty: false,
  showSunPath: true,
  leftTab: 'photo',
  uiMode: initialUiMode(),
  keyDialogOpen: false,
  pendingSelection: null,
  alignMode: false,
  addViewOpen: false,
  sharedQuota: null,
  cameraUndo: {},
  addExtraView: (v0) => {
    const sc = get().scene;
    if (!sc) return;
    // Same camera preparation as loadScene (pitch from the ground line, facade-regularity alignment).
    const c = calibrateViewCamera(photoViewGeometry(sc, v0), v0.camera, v0.analysis.detections);
    const v = { ...v0, ...(c.view ?? {}), camera: c.camera };
    const existing = [...get().trees];
    const vegTrees = treesFromVegetation(photoViewGeometry(sc, v), v.camera, v.analysis.detections, existing);
    set({
      scene: { ...sc, extraViews: [...(sc.extraViews ?? []).filter((x) => x.id !== v.id), v], trees: [...sc.trees, ...vegTrees.filter((t) => !sc.trees.some((x) => x.id === t.id))] },
      trees: [...existing, ...vegTrees],
      viewCameras: { ...get().viewCameras, [v.id]: structuredClone(v.camera) },
      viewDetections: { ...get().viewDetections, [v.id]: structuredClone(v.analysis.detections) },
      activeViewId: v.id,
    });
  },
  removeExtraView: (id) => {
    const sc = get().scene;
    if (!sc) return;
    const vc = { ...get().viewCameras };
    const vd = { ...get().viewDetections };
    delete vc[id];
    delete vd[id];
    const undo = { ...get().cameraUndo };
    delete undo[id];
    set({ scene: { ...sc, extraViews: (sc.extraViews ?? []).filter((x) => x.id !== id) }, viewCameras: vc, viewDetections: vd, cameraUndo: undo, activeViewId: get().activeViewId === id ? 'primary' : get().activeViewId });
  },
  themePreference: initialThemePreference(),
  setThemePreference: (t) => {
    try {
      localStorage.setItem('sv.theme', t);
    } catch {
      /* storage unavailable */
    }
    set({ themePreference: t });
  },
  setUiMode: (m) => {
    try {
      localStorage.setItem('sv.uiMode', m);
    } catch {
      /* storage unavailable */
    }
    set({ uiMode: m });
  },
  activeViewId: 'primary',
  viewCameras: {},
  viewDetections: {},
  notice: null,
  set: (p) => {
    // Every date write (date inputs, heatmap cells, season chips, snapshots) goes through here:
    // keep it a real YYYY-MM-DD inside the range the UI offers, or ignore it.
    if ('date' in p) {
      const d = clampDate(p.date as string);
      if (!d) {
        const { date: _bad, ...rest } = p;
        void _bad;
        p = rest;
      } else if (d !== p.date) p = { ...p, date: d };
    }
    set(p);
  },
  setViewCamera: (viewId, p, provenance) => {
    if (viewId === 'primary') return get().setCamera(p, provenance);
    const cam = get().viewCameras[viewId];
    if (!cam) return;
    const prov = { ...cam.provenance, ...(provenance ?? {}) };
    if (!provenance) markManual(prov, p);
    set({ viewCameras: { ...get().viewCameras, [viewId]: { ...cam, ...p, provenance: prov } } });
  },
  loadScene: (scene0) => {
    // Solve every view's camera (pitch from the ground line, then facade regularity) and keep the
    // solved cameras in the scene as the reference, so "Reset camera" returns to them.
    const scene = prepareScene(scene0);
    const camera = structuredClone(scene.camera);
    set({
      scene,
      camera,
      cameraUndo: {},
      detections: structuredClone(scene.analysis.detections),
      trees: structuredClone(scene.trees),
      overrides: {},
      extraBuildings: [],
      selectedWindowIds: [],
      hoveredWindowId: null,
      selectedBuildingId: scene.targetBuildingId,
      activeViewId: 'primary',
      // A fresh scene opens in plain selection: no add-window tool, align mode or add-view dialog
      // left over from the previous scene (the upload flow sets photoTool again after loading).
      photoTool: 'select',
      alignMode: false,
      addViewOpen: false,
      viewCameras: Object.fromEntries((scene.extraViews ?? []).map((v) => [v.id, structuredClone(v.camera)])),
      viewDetections: Object.fromEntries((scene.extraViews ?? []).map((v) => [v.id, structuredClone(v.analysis.detections)])),
      notice: null,
      snapshots: [],
      settings: defaultSettings,
      route: { name: 'workspace' },
      error: null,
      loading: null,
    });
  },
  setCamera: (p, provenance) => {
    const cam = get().camera;
    if (!cam) return;
    const prov = { ...cam.provenance, ...(provenance ?? {}) };
    if (!provenance) markManual(prov, p);
    set({ camera: { ...cam, ...p, provenance: prov } });
  },
  setOverride: (id, o) => {
    const cur = { ...get().overrides };
    if (o === null) delete cur[id];
    else {
      const merged = { ...(cur[id] ?? {}), ...o };
      for (const k of Object.keys(merged) as (keyof BuildingOverride)[]) if (merged[k] == null) delete merged[k];
      if (Object.keys(merged).length) cur[id] = merged;
      else delete cur[id];
    }
    set({ overrides: cur });
  },
  toggleWindow: (id, additive) => {
    const cur = get().selectedWindowIds;
    if (additive) set({ selectedWindowIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    else set({ selectedWindowIds: cur.length === 1 && cur[0] === id ? [] : [id] });
  },
  updateDetection: (id, p) => {
    const dets = get().detections;
    if (p === null) set({ detections: dets.filter((d) => d.id !== id), selectedWindowIds: get().selectedWindowIds.filter((w) => w !== 'win-' + id) });
    else set({ detections: dets.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  },
  addDetection: (d) => set({ detections: [...get().detections, d] }),
  resetViewCamera: (viewId) => {
    const sc = get().scene;
    if (!sc) return;
    const ref = viewId === 'primary' ? sc.camera : sc.extraViews?.find((v) => v.id === viewId)?.camera;
    const cur = viewId === 'primary' ? get().camera : get().viewCameras[viewId];
    if (!ref || !cur) return;
    const undo = { ...get().cameraUndo, [viewId]: [...(get().cameraUndo[viewId] ?? []), cur].slice(-20) };
    if (viewId === 'primary') set({ camera: structuredClone(ref), cameraUndo: undo });
    else set({ viewCameras: { ...get().viewCameras, [viewId]: structuredClone(ref) }, cameraUndo: undo });
  },
  autoAlignView: (viewId) => {
    const sc = get().scene;
    if (!sc) return { changed: false, notes: ['No scene loaded.'] };
    const pv = viewId === 'primary' ? null : sc.extraViews?.find((v) => v.id === viewId);
    const cam = viewId === 'primary' ? get().camera : get().viewCameras[viewId];
    if (!cam || (viewId !== 'primary' && !pv)) return { changed: false, notes: ['Unknown view.'] };
    const geo: ViewGeometry = pv ? photoViewGeometry(sc, pv) : sc;
    const detections = viewId === 'primary' ? get().detections : (get().viewDetections[viewId] ?? pv!.analysis.detections);
    // An oblique street view keeps its vanishing-point term (never re-initialised here: the user's camera stays the start).
    const persp = streetPerspective(detections, geo.image);
    const tgt = geo.footprints.find((f) => f.id === geo.targetBuildingId);
    // (the facade may be on either side of the point: lib/vanishing obliqueStart tries both)
    const vanishingPoint =
      persp && tgt
        ? (['right', 'left'] as const)
            .map((side) => ({ x: persp.vp.x, y: persp.vp.y, dir: recedingDirection(facadePlane(tgt.id, tgt.ring, geo.facadeEdgeIndex), side), sigmaDeg: 1 }))
            .find((v) => vanishingAngleError(cam, geo.image, v, v.dir) <= VP_REINIT_DEG)
        : undefined;
    const al = autoAlignCamera({ ...geo, camera: cam, detections }, { hfovRange: hfovRangeFor(cam), vanishingPoint });
    if (al.changed) {
      const undo = { ...get().cameraUndo, [viewId]: [...(get().cameraUndo[viewId] ?? []), cam].slice(-20) };
      if (viewId === 'primary') set({ camera: al.camera, cameraUndo: undo });
      else set({ viewCameras: { ...get().viewCameras, [viewId]: al.camera }, cameraUndo: undo });
    }
    return { changed: al.changed, notes: al.notes, spread0: al.terms.spread0, spread: al.terms.spread };
  },
  pushCameraUndo: (viewId) => {
    const cur = viewId === 'primary' ? get().camera : get().viewCameras[viewId];
    if (!cur) return;
    set({ cameraUndo: { ...get().cameraUndo, [viewId]: [...(get().cameraUndo[viewId] ?? []), cur].slice(-20) } });
  },
  undoViewCamera: (viewId) => {
    const stack = get().cameraUndo[viewId] ?? [];
    const prev = stack[stack.length - 1];
    if (!prev) return false;
    const undo = { ...get().cameraUndo, [viewId]: stack.slice(0, -1) };
    if (viewId === 'primary') set({ camera: prev, cameraUndo: undo });
    else if (get().viewCameras[viewId]) set({ viewCameras: { ...get().viewCameras, [viewId]: prev }, cameraUndo: undo });
    else return false;
    return true;
  },
}));
