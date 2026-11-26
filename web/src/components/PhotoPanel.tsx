import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  annotationRenderers,
  BasePolygonStyle,
  BaseBoxStyle,
  BaseLabelStyle,
  createImageUrlMediaSource,
  createMediaSession,
  DepthMapKind,
  DetectionFrameRetentionMode,
  LabelVisibilityMode,
  MediaRendererFit,
  type Detection as SvDetection,
  type MediaRendererPresentation,
} from 'supervision';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { useSimContext } from './SimContext';
import type { Detection, Vec3 } from '../schema/scene';
import { cameraBasis, worldToPixel } from '../lib/camera';
import { facadePoint } from '../lib/obstacles';
import { clusterRows } from '../lib/reconstruct';
import { loadDepthArray } from '../lib/useSim';
import { useActiveView } from '../lib/views';
import { Toggle } from './ui';
import AlignCheck, { FIT_EXACT_HINT, fitChipColor, fitRedundancy } from './photo/AlignCheck';
import ModelCredit, { creditLink } from './photo/ModelCredit';
import AddViewDialog from './photo/AddViewDialog';
import LayersPopover, { classVisible } from './photo/LayersPopover';
import ViewStrip, { depthBaseFor, resolveViewAsset } from './photo/ViewStrip';
import { useThemeColors } from '../lib/theme';

type LiveSession = Awaited<ReturnType<typeof createMediaSession>>;

export const CLASS_COLORS: Record<string, number> = {
  window: 0xf5b544,
  facade: 0x7d97b8,
  'balcony-fence': 0xc792ea,
  vegetation: 0x6fcf97,
  street: 0x8a929e, // #0d0f12 label text ≥ 4.5:1 on every class colour
  car: 0xe06c75,
  shop: 0x56b6c2,
  fence: 0xd19a66,
  'non-building-infrastructure': 0x9aa1ab,
  'traffic-infrastructure': 0xd0644f,
};

/** The visible window whose box is nearest to `p` (media px), within `tol`; null when none is. */
export function nearestWindow(dets: Detection[], p: { x: number; y: number }, tol: number): Detection | null {
  let best: Detection | null = null;
  let bestD = tol;
  for (const d of dets) {
    if (d.cls !== 'window' || d.deleted) continue;
    const [x0, y0, x1, y1] = d.bbox;
    const dist = Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(y0 - p.y, 0, p.y - y1));
    if (dist <= bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

function toSv(d: Detection, selected: Set<string>): SvDetection {
  const [x0, y0, x1, y1] = d.bbox;
  return {
    id: d.id,
    className: d.cls,
    confidence: d.confidence,
    rect: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 },
    polygon: d.polygon && d.polygon.length >= 3 ? { points: d.polygon.map(([x, y]) => ({ x, y })) } : undefined,
    zIndex: d.cls === 'window' ? 10 : d.cls === 'facade' ? 0 : 5,
    metadata: { selected: selected.has('win-' + d.id), source: d.source },
  };
}

/* ---- detection edits routed to the view that owns them ------------------------------------ */

function viewDetectionList(viewId: string): Detection[] {
  const st = useStore.getState();
  return st.viewDetections[viewId] ?? st.scene?.extraViews?.find((v) => v.id === viewId)?.analysis.detections ?? [];
}

/** Patch a detection of any view: 'primary' → store.detections, otherwise viewDetections[viewId]. */
export function editViewDetection(viewId: string, id: string, patch: Partial<Detection>) {
  const st = useStore.getState();
  if (viewId === 'primary') return st.updateDetection(id, patch);
  st.set({ viewDetections: { ...st.viewDetections, [viewId]: viewDetectionList(viewId).map((d) => (d.id === id ? { ...d, ...patch } : d)) } });
}

/** Append a detection to any view. */
export function addViewDetection(viewId: string, d: Detection) {
  const st = useStore.getState();
  if (viewId === 'primary') return st.addDetection(d);
  st.set({ viewDetections: { ...st.viewDetections, [viewId]: [...viewDetectionList(viewId), d] } });
}

/** Loaded scenes whose simple-mode default layers were already applied (keyed by scene.analysis, which addExtraView keeps). */
const quietScenes = new WeakSet<object>();

/** Text drawn over the photo (detection labels, floor lines, dimensions). */
const OVERLAY_FONT = 'Inter, system-ui, sans-serif';

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

export default function PhotoPanel() {
  const scene = useStore((s) => s.scene);
  const view = useActiveView();
  if (!scene || !view) return <div className="grid h-full place-items-center text-xs text-ink-400">No photograph loaded.</div>;
  return <PhotoPanelBody scene={scene} view={view} />;
}

type SceneT = NonNullable<ReturnType<typeof useStore.getState>['scene']>;
type ViewT = NonNullable<ReturnType<typeof useActiveView>>;
const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));

function PhotoPanelBody({ scene, view }: { scene: SceneT; view: ViewT }) {
  const tc = useThemeColors();
  const layers = useStore((s) => s.layers);
  const selected = useStore((s) => s.selectedWindowIds);
  const hovered = useStore((s) => s.hoveredWindowId);
  const tool = useStore((s) => s.photoTool);
  const uiMode = useStore((s) => s.uiMode);
  const alignMode = useStore((s) => s.alignMode);
  const set = useStore((s) => s.set);
  const toggleWindow = useStore((s) => s.toggleWindow);
  const sim = useSimContext();

  const isPrimary = view.id === 'primary';
  const detections = view.detections;
  const camera = view.camera;
  const W = view.image.width;
  const H = view.image.height;

  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [vp, setVp] = useState({ s: 1, x: 0, y: 0, w: 0, h: 0 });
  // (scaleRef mirrors vp.s for the renderer's pointer callback, which is created once.)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const viewIdRef = useRef(view.id);
  viewIdRef.current = view.id;
  /** For the finger-tolerant window pick (onPointerPress): current detections and media→screen scale. */
  const detsRef = useRef(detections);
  detsRef.current = detections;
  const scaleRef = useRef(1);
  // Apartments are picked on the main photo (the reconstruction's windows come from it).
  const selSet = useMemo(() => (isPrimary ? new Set(selected) : new Set<string>()), [selected, isPrimary]);

  // Simple mode starts quiet: no masks, labels, boxes or floor lines. Once per
  // loaded scene, so a later "Show detections" survives the panel remounting (layout changes).
  useEffect(() => {
    const st = useStore.getState();
    if (st.uiMode !== 'simple' || quietScenes.has(scene.analysis)) return;
    quietScenes.add(scene.analysis);
    st.set({ layers: { ...st.layers, masks: false, labels: false, boxes: false, floors: false } });
  }, [scene.analysis]);

  const visibleDets = useMemo(() => detections.filter((d) => !d.deleted && classVisible(layers.classes, d.cls)), [detections, layers.classes]);

  const imgUrl = resolveViewAsset(scene, view.image.url);

  // ---- presentation -----------------------------------------------------------------------
  const presentation = useMemo<MediaRendererPresentation>(() => {
    const color = (d: SvDetection) => CLASS_COLORS[d.className ?? ''] ?? 0xc9ccd1;
    const isSel = (d: SvDetection) => Boolean((d.metadata as { selected?: boolean } | undefined)?.selected);
    const polygonStyle = new BasePolygonStyle({
      fill: (d, ctx) => {
        if (!layers.masks) return isSel(d) ? { color: 0xf5b544, alpha: 0.45 } : ctx.hovered && d.className === 'window' ? { color: 0xf8c160, alpha: 0.18 } : null;
        const c = color(d);
        const base = d.className === 'facade' ? 0.1 : d.className === 'window' ? 0.28 : 0.2;
        return { color: isSel(d) ? 0xffd78a : c, alpha: isSel(d) ? 0.55 : ctx.hovered ? base + 0.2 : base };
      },
      stroke: (d, ctx) => {
        if (!layers.masks) {
          // Simple look: window outlines only, 1.5px sun-400.
          if (d.className !== 'window') return { color: 0, alpha: 0, width: 0 };
          return { color: isSel(d) ? 0xffd78a : 0xf8c160, alpha: 0.95, width: isSel(d) ? 2.5 : ctx.hovered ? 2 : 1.5 };
        }
        return { color: isSel(d) ? 0xffffff : color(d), alpha: 0.95, width: isSel(d) ? 2.5 : ctx.hovered ? 2 : d.className === 'facade' ? 1.5 : 1.2 };
      },
    });
    const boxStyle = new BaseBoxStyle({
      stroke: (d, ctx) => ({ color: isSel(d) ? 0xffffff : color(d), alpha: 0.9, width: ctx.hovered || isSel(d) ? 2 : 1.25 }),
      fill: null,
    });
    const labelStyle = new BaseLabelStyle({
      includeConfidence: true,
      visibilityMode: LabelVisibilityMode.HoveredOnly,
      background: (d) => ({ color: color(d), alpha: 0.92, cornerRadius: 3, paddingX: 4, paddingY: 2 }),
      textStyle: () => ({ color: 0x0d0f12, fontFamily: OVERLAY_FONT, fontSize: 11, fontWeight: 600 }),
      text: (d) => `${d.className}${(d.metadata as { source?: string })?.source === 'manual' ? ' · manual' : ` ${Math.round((d.confidence ?? 0) * 100)}%`}`,
    });
    const renderers = [
      ...(layers.depth ? [annotationRenderers.depth({ colormap: 'turbo', opacity: 0.6, range: 'auto' })] : []),
      annotationRenderers.polygon({ style: polygonStyle }),
      ...(layers.boxes ? [annotationRenderers.box({ style: boxStyle })] : []),
      ...(layers.labels ? [annotationRenderers.label({ style: labelStyle })] : []),
    ];
    // Letterbox colour follows the theme (setPresentation below re-applies it when the theme changes).
    return { backgroundColor: tc.photoBg, renderers, polygonStyle, boxStyle: layers.boxes ? boxStyle : null, labelStyle: layers.labels ? labelStyle : null };
  }, [layers.masks, layers.boxes, layers.labels, layers.depth, tc.photoBg]);

  // ---- session lifecycle ------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setReady(false);
    setErr(null);
    // Each session gets its own mount node so a late-resolving disposed session
    // (React StrictMode double-mount) can't tear down the live one's canvas.
    const mount = document.createElement('div');
    mount.style.cssText = 'position:absolute;inset:0';
    host.appendChild(mount);
    let created: LiveSession | null = null;
    createMediaSession({
      container: mount,
      // Still image: Supervision.js's image source (URL strings go through the video demuxer).
      media: createImageUrlMediaSource(imgUrl),
      // Appendable (memory-only) source so edits can replace the frame in place.
      detections: { appendable: { datasetId: 'sunvision-' + hash(imgUrl), clearOnCreate: true, retention: { mode: DetectionFrameRetentionMode.MemoryOnly } } },
      presentation,
      renderer: {
        fit: MediaRendererFit.Contain,
        interaction: {
          mode: 'always' as never,
          multiSelect: true,
          preferTopmost: true,
          filter: (d) => d.className === 'window',
          onHover: (pick) => {
            const id = pick?.detection.id;
            useStore.getState().set({ hoveredWindowId: id != null && viewIdRef.current === 'primary' ? 'win-' + id : null });
          },
          onPointerPress: ({ input, pick }) => {
            const t = toolRef.current;
            if (t === 'add-window' || useStore.getState().alignMode) return 'handled';
            // Fingers: windows can be a few pixels wide on a phone, so a tap that misses every
            // window picks the nearest one within ~22 screen px (as AlignCheck's coarse hit radius).
            const near = !pick && input.point ? nearestWindow(detsRef.current, input.point, 22 / (scaleRef.current || 1)) : null;
            if (near && (typeof matchMedia !== 'function' || matchMedia('(pointer: coarse)').matches)) {
              const id = near.id;
              const vid = viewIdRef.current;
              if (t === 'delete') editViewDetection(vid, id, { deleted: true });
              else if (vid === 'primary') toggleWindow('win-' + id, Boolean(input.shiftKey || input.metaKey || input.ctrlKey));
              return 'handled';
            }
            if (pick && pick.detection.className === 'window') {
              const id = String(pick.detection.id);
              const vid = viewIdRef.current;
              if (t === 'delete') editViewDetection(vid, id, { deleted: true });
              else if (vid === 'primary') toggleWindow('win-' + id, Boolean(input.shiftKey || input.metaKey || input.ctrlKey));
              return 'handled';
            }
            return 'continue';
          },
        },
      },
    })
      .then((s) => {
        created = s;
        if (disposed) {
          s.destroy();
          mount.remove();
          return;
        }
        sessionRef.current = s;
        const wait = () =>
          new Promise<void>((resolve) => {
            const ok = () => !['loading'].includes(String(s.getState().status));
            if (ok()) return resolve();
            const un = s.subscribe(() => {
              if (ok()) {
                un();
                resolve();
              }
            });
          });
        return wait().then(() => {
          if (!disposed) setReady(true);
        });
      })
      .catch((e) => setErr(String(e?.message ?? e)));
    return () => {
      disposed = true;
      if (created) {
        created.destroy();
        mount.remove();
      }
      if (sessionRef.current === created) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgUrl]);

  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !ready) return;
    s.replaceDetectionFrames([{ mediaTime: 0, detections: visibleDets.map((d) => toSv(d, selSet)) }])
      .then(() => safeRefresh(s))
      .catch((e) => console.warn('detections', e));
  }, [visibleDets, selSet, ready]);

  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !ready) return;
    s.setPresentation(presentation);
    safeRefresh(s);
  }, [presentation, ready]);

  // Depth map → Supervision.js depth renderer (per view; extra views' paths are relative to the example).
  const depthInfo = view.analysis.depth;
  useEffect(() => {
    const s = sessionRef.current;
    const info = depthInfo;
    if (!s || !ready || !info || !s.setDepth) return;
    if (!layers.depth) return;
    let alive = true;
    loadDepthArray(info, depthBaseFor(scene, info.binUrl)).then((arr) => {
      if (!alive || !arr) return;
      s.setDepth!({ map: { kind: DepthMapKind.RelativeInverse, width: info.width, height: info.height, samples: { encoding: 'scaled16', values: arr, scale: (info.rawMax - info.rawMin) / 65535 || 1 } } })
        .then(() => safeRefresh(s))
        .catch((e) => console.warn('depth', e));
    });
    return () => {
      alive = false;
    };
  }, [ready, layers.depth, depthInfo, scene]);

  // Viewport tracking for the SVG overlays
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = sessionRef.current;
      const host = hostRef.current;
      if (s && host) {
        const a = s.renderer.mediaToScreen({ x: 0, y: 0 });
        const b = s.renderer.mediaToScreen({ x: 1000, y: 0 });
        const sc = (b.x - a.x) / 1000;
        const w = host.clientWidth;
        const h = host.clientHeight;
        // Before the first layout (or with a zero-sized host) the mapping can be NaN/0: keep the last good one.
        if (finite(sc, a.x, a.y) && sc > 0) scaleRef.current = sc;
        if (finite(sc, a.x, a.y) && sc > 0)
          setVp((v) => (Math.abs(v.s - sc) > 1e-6 || Math.abs(v.x - a.x) > 0.25 || Math.abs(v.y - a.y) > 0.25 || v.w !== w || v.h !== h ? { s: sc, x: a.x, y: a.y, w, h } : v));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 3D → photo selection sync
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !ready) return;
    const ids = isPrimary ? selected.map((w) => w.replace(/^win-/, '')) : [];
    try {
      s.renderer.setSelectedDetection(ids.length ? { detectionIds: ids } : null);
    } catch {
      /* ignore stale ids */
    }
  }, [selected, ready, isPrimary]);

  // ---- overlay geometry (floor lines and dimensions are measured on the main photo) --------
  const m2s = (x: number, y: number) => [vp.x + x * vp.s, vp.y + y * vp.s] as const;
  const overlay = useMemo(() => {
    if (!sim || !isPrimary) return null;
    const b = cameraBasis(camera, W, H);
    const proj = (p: Vec3) => worldToPixel(b, p);
    // Observed window rows on the target facade, drawn at their measured sill height.
    const floorLines: { pts: [number, number][]; label: string }[] = [];
    const tp = sim.recon.targetPlane;
    const tm = sim.recon.buildings[scene.targetBuildingId];
    if (!tp || !finite(tp.length) || tp.length <= 0) return null;
    const tw = sim.recon.windows.filter((w) => w.buildingId === tp.buildingId && w.edgeIndex === tp.edgeIndex);
    const uA = tw.length ? Math.max(0, Math.min(...tw.map((w) => w.u - w.width / 2)) - 1) : 0;
    const uB = tw.length ? Math.min(tp.length, Math.max(...tw.map((w) => w.u + w.width / 2)) + 1) : tp.length;
    const rows = clusterRows(tw.map((w) => ({ id: w.id, z: w.z })), 1.0);
    const byId = new Map(tw.map((w) => [w.id, w]));
    // One line per floor: when two observed rows map to the same floor (a stray window from a
    // neighbour, a fire escape, a mezzanine), the row with the most windows represents it.
    const perFloor = new Map<number, { sill: number; n: number }>();
    for (const r of rows) {
      const ws = r.ids.map((id) => byId.get(id)).filter((w): w is NonNullable<typeof w> => !!w);
      if (!ws.length) continue;
      const sill = [...ws.map((w) => w.z - w.height / 2)].sort((a, b) => a - b)[Math.floor(ws.length / 2)];
      const floor = [...ws.map((w) => w.floor)].sort((a, b) => a - b)[Math.floor(ws.length / 2)];
      const prev = perFloor.get(floor);
      if (!prev || ws.length > prev.n) perFloor.set(floor, { sill, n: ws.length });
    }
    for (const [floor, { sill }] of perFloor) {
      const a = proj(facadePoint(tp, uA, sill));
      const c = proj(facadePoint(tp, uB, sill));
      if (a && c && finite(a[0], a[1], c[0], c[1], sill)) floorLines.push({ pts: [a, c], label: `F${floor} · ${sill.toFixed(1)} m` });
    }
    const g0 = proj(facadePoint(tp, uA, 0));
    const g1 = proj(facadePoint(tp, uB, 0));
    if (g0 && g1 && finite(g0[0], g0[1], g1[0], g1[1])) floorLines.push({ pts: [g0, g1], label: 'street' });
    const height = tm?.height?.value;
    const ok = (q: [number, number] | null) => (q && finite(q[0], q[1]) ? q : null);
    const roofTop = typeof height === 'number' && Number.isFinite(height) ? ok(proj(facadePoint(tp, tp.length / 2, height))) : null;
    const ground = ok(proj(facadePoint(tp, tp.length / 2, 0)));
    return { floorLines, roofTop, ground, height: height ?? NaN };
  }, [sim, camera, scene, isPrimary, W, H]);

  // SVG text over a photo: theme text colour with a contrasting halo, readable on any facade.
  const haloText = { fill: tc.overlayText, stroke: tc.overlayStroke, strokeWidth: 3, strokeOpacity: 0.85, paintOrder: 'stroke', fontSize: 11, fontWeight: 500, fontFamily: OVERLAY_FONT, fontVariantNumeric: 'tabular-nums' } as const;

  const winById = useMemo(() => new Map(isPrimary ? (sim?.recon.windows.map((w) => [w.detectionId, w]) ?? []) : []), [sim, isPrimary]);

  // ---- add-window tool -------------------------------------------------------------------------
  const toMedia = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [(e.clientX - r.left - vp.x) / vp.s, (e.clientY - r.top - vp.y) / vp.s] as const;
  };

  const rms = camera.alignment?.rms;
  const showHint = isPrimary && !alignMode && tool === 'select' && selected.length === 0 && ready;

  return (
    <div className="relative flex h-full flex-col">
      {/* ---- toolbar (one row, 40px) ---------------------------------------------------- */}
      {/* Wraps onto a second row on phones; 44px targets on touch screens. */}
      <div
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-700 bg-ink-900 px-2 py-1 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_label]:min-h-11"
        role="toolbar"
        aria-label="Photo tools"
      >
        <ToolPicker />
        <span aria-hidden className="h-4 w-px bg-ink-700" />
        <div className="pl-1">
          <Toggle checked={layers.masks && layers.labels} onChange={(v) => set({ layers: { ...layers, masks: v, labels: v } })} label={<><span className="sm:hidden">Detections</span><span className="hidden sm:inline">Show detections</span></>} />
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {typeof rms === 'number' && (
            // Hidden on phones so the toolbar stays one row (the fit is also shown in "Check the fit").
            <span
              className="mr-1 hidden h-6 items-center gap-1.5 rounded-sm px-1.5 text-[11px] text-ink-300 sm:inline-flex"
              title={fitRedundancy(camera.alignment?.points ?? []) > 0 ? 'Reprojection error of the corners you placed, from the camera solver' : FIT_EXACT_HINT}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: fitChipColor(rms, camera.alignment?.points ?? []) }} aria-hidden />
              <span className="num">Fit {rms.toFixed(1)} px</span>
            </span>
          )}
          <button
            type="button"
            aria-pressed={alignMode}
            onClick={() => set({ alignMode: !alignMode })}
            className={clsx(
              // Phones: hidden (not in align mode) so the toolbar is one row; the alignment banner's
              // "Fix it" and the report's "Check the fit" open the same mode.
              'h-7 items-center rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11',
              alignMode ? 'inline-flex' : 'hidden sm:inline-flex',
              alignMode ? 'bg-selected text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper',
            )}
          >
            Check the fit
          </button>
          {uiMode === 'advanced' && <LayersPopover detections={detections} colors={CLASS_COLORS} primary={isPrimary} />}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-ink-950">
        <div ref={hostRef} className="absolute inset-0" />
        {!ready && !err && <div className="absolute inset-0 grid place-items-center text-xs text-ink-400">Preparing photograph…</div>}
        {err && <div className="absolute inset-0 grid place-items-center p-6 text-center text-xs text-danger-text">Could not render the photograph: {err}</div>}

        {/* SVG overlay (pointer-transparent unless drawing) */}
        <svg
          className={clsx('absolute inset-0 h-full w-full', tool === 'add-window' && !alignMode ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
          width={vp.w}
          height={vp.h}
          onPointerDown={(e) => {
            if (tool !== 'add-window' || alignMode) return;
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            const [x, y] = toMedia(e);
            setDrag({ x0: x, y0: y, x1: x, y1: y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const [x, y] = toMedia(e);
            setDrag({ ...drag, x1: x, y1: y });
          }}
          onPointerCancel={() => setDrag(null)}
          onPointerUp={() => {
            if (!drag) return;
            const x0 = Math.max(0, Math.min(drag.x0, drag.x1));
            const x1 = Math.min(W, Math.max(drag.x0, drag.x1));
            const y0 = Math.max(0, Math.min(drag.y0, drag.y1));
            const y1 = Math.min(H, Math.max(drag.y0, drag.y1));
            setDrag(null);
            if (x1 - x0 < 4 || y1 - y0 < 4) return;
            const id = 'manual-' + Math.random().toString(36).slice(2, 8);
            addViewDetection(view.id, { id, cls: 'window', confidence: 1, bbox: [x0, y0, x1, y1], polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], source: 'manual' });
            if (isPrimary) toggleWindow('win-' + id, true);
          }}
        >
          {ready && overlay && layers.floors &&
            overlay.floorLines.map((l, i) => {
              const [a, b] = l.pts.map(([x, y]) => m2s(x, y));
              return (
                <g key={i}>
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={tc.overlayStroke} strokeOpacity={0.5} strokeWidth={3} />
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={tc.overlayText} strokeOpacity={0.75} strokeDasharray="2 4" />
                  <text x={Math.min(a[0], b[0]) + 4} y={(a[1] + b[1]) / 2 - 3} {...haloText}>
                    {l.label}
                  </text>
                </g>
              );
            })}
          {ready && overlay && layers.dims && overlay.roofTop && overlay.ground && (
            <g>
              {(() => {
                const [tx, ty] = m2s(...overlay.roofTop);
                const [gx, gy] = m2s(...overlay.ground);
                return (
                  <>
                    <line x1={tx} y1={ty} x2={gx} y2={gy} stroke={tc.overlayStroke} strokeOpacity={0.6} strokeWidth={3.5} />
                    <line x1={tx} y1={ty} x2={gx} y2={gy} stroke={tc.overlayText} strokeWidth={1.25} markerStart="url(#arr)" markerEnd="url(#arr)" />
                    <rect x={(tx + gx) / 2 + 6} y={(ty + gy) / 2 - 10} width={56} height={20} rx={5} fill={tc.overlayStroke} opacity={0.9} />
                    <text x={(tx + gx) / 2 + 13} y={(ty + gy) / 2 + 4} fill={tc.overlayText} fontSize={11} fontWeight={500} fontFamily={OVERLAY_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {overlay.height.toFixed(1)} m
                    </text>
                  </>
                );
              })()}
              {visibleDets
                .filter((d) => d.cls === 'window')
                .map((d) => {
                  const w = winById.get(d.id);
                  if (!w) return null;
                  const [x, y] = m2s(d.bbox[0], d.bbox[3]);
                  return (
                    <text key={d.id} x={x} y={y + 11} {...haloText}>
                      {w.width.toFixed(1)}×{w.height.toFixed(1)}
                    </text>
                  );
                })}
            </g>
          )}
          {ready && hovered && isPrimary && (() => {
            const d = detections.find((x) => 'win-' + x.id === hovered);
            if (!d) return null;
            const [x0, y0] = m2s(d.bbox[0], d.bbox[1]);
            const [x1, y1] = m2s(d.bbox[2], d.bbox[3]);
            return (
              <g>
                <rect x={x0 - 2} y={y0 - 2} width={x1 - x0 + 4} height={y1 - y0 + 4} fill="none" stroke={tc.overlayStroke} strokeOpacity={0.7} strokeWidth={3.5} rx={2} />
                <rect x={x0 - 2} y={y0 - 2} width={x1 - x0 + 4} height={y1 - y0 + 4} fill="none" stroke={tc.overlayText} strokeWidth={1.5} rx={2} />
              </g>
            );
          })()}
          {drag && (() => {
            const [x0, y0] = m2s(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1));
            const [x1, y1] = m2s(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
            return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--color-accent)" fillOpacity={0.12} stroke="var(--color-accent)" strokeWidth={1} />;
          })()}
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={tc.overlayText} />
            </marker>
          </defs>
        </svg>

        {/* Alignment wireframe, banner and corner handles */}
        <AlignCheck view={view} sceneId={scene.id} vp={vp} ready={ready} heights={sim?.geo.heights ?? {}} />

        {view.image.attribution && (
          <a
            href={view.image.attribution.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-2 right-2 max-w-[40%] truncate rounded-sm bg-ink-900/85 px-1.5 py-0.5 text-[11px] text-ink-400 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent"
            title={`${view.image.attribution.title} — ${view.image.attribution.creator}, ${view.image.attribution.license}`}
          >
            © {view.image.attribution.creator} · {view.image.attribution.license}
          </a>
        )}
        {showHint && (
          <div className="fade-in pointer-events-none absolute left-2 top-2 flex h-7 max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg bg-ink-900 px-2.5 text-xs text-paper shadow-float" role="status">
            {/* a window outline, as drawn on the photo */}
            <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden className="shrink-0">
              <rect x="0.75" y="0.75" width="7.5" height="9.5" rx="1" fill="none" stroke="var(--color-sun-400)" strokeWidth="1.5" />
            </svg>
            <span className="pointer-coarse:hidden">Click a window to pick an apartment</span>
            <span className="hidden pointer-coarse:inline">Tap a window to pick an apartment</span>
          </div>
        )}
        {!isPrimary && !alignMode && tool === 'select' && ready && (
          <div className="fade-in pointer-events-none absolute left-2 top-2 flex min-h-7 max-w-[calc(100%-1rem)] items-center rounded-lg bg-ink-900 px-2.5 py-1 text-xs text-ink-200 shadow-float" role="status">
            A photo of the surroundings. Pick apartment windows on the main photo.
          </div>
        )}
        {tool !== 'select' && !alignMode && (
          <div className="fade-in pointer-events-none absolute left-1/2 top-2 flex min-h-7 max-w-[calc(100%-1rem)] -translate-x-1/2 items-center rounded-lg bg-ink-900 px-2.5 py-1 text-center text-xs text-paper shadow-float">
            {tool === 'add-window' ? 'Drag a rectangle around a missing window' : 'Tap or click a window detection to remove it'}
          </div>
        )}
      </div>

      <ViewStrip />
      <DataCredit model={view.analysis.model} />
      <AddViewDialog />
    </div>
  );
}

/**
 * Attribution where the detections are drawn: the facade model (CC BY 4.0 requires the creator,
 * the title and the licence), "Powered by Roboflow", and the OpenStreetMap footprints (ODbL).
 */
function DataCredit({ model }: { model: { provider: string; modelId: string; universeUrl?: string } }) {
  return (
    <p className="shrink-0 border-t border-ink-700 bg-ink-900 px-3 py-1.5 text-[11px] leading-4 text-ink-400">
      {model.provider !== 'manual' && (
        <>
          <ModelCredit model={model} />
          {' · '}
        </>
      )}
      Footprints ©{' '}
      <a className={creditLink} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        OpenStreetMap contributors
      </a>{' '}
      (ODbL)
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* "Pick windows" | "Fix windows" (menu)                                                         */
/* ------------------------------------------------------------------------------------------ */

function ToolPicker() {
  const tool = useStore((s) => s.photoTool);
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  const fixing = tool !== 'select';
  // Menu: 28px rows, a check column on the left, blue highlight on hover / focus.
  const item =
    'flex h-7 w-full items-center gap-2 rounded-md pl-1.5 pr-2.5 text-left text-xs text-ink-200 hover:bg-accent-500 hover:text-on-accent focus-visible:bg-accent-500 focus-visible:text-on-accent focus-visible:outline-none pointer-coarse:h-11';
  const tab = 'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11';
  const check = (on: boolean) => (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={clsx('shrink-0', !on && 'invisible')}>
      <path d="M2.5 6.25 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <div ref={wrapRef} className="relative inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-pressed={tool === 'select'}
        onClick={() => set({ photoTool: 'select' })}
        title="Click windows to pick an apartment (Shift/⌘ for several)"
        className={clsx(tab, tool === 'select' ? 'bg-selected text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper')}
      >
        Pick windows
      </button>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={clsx(tab, 'gap-1 pr-1.5', fixing ? 'bg-selected text-paper' : open ? 'bg-ink-800 text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper')}
      >
        Fix windows
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={clsx('text-ink-400 transition-transform motion-reduce:transition-none', open && 'rotate-180')}>
          <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Fix windows" onKeyDown={onMenuKey} className="pop-in absolute left-0 top-full z-30 mt-1 w-56 rounded-lg bg-ink-900 p-1 shadow-panel">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={tool === 'add-window'}
            className={item}
            onClick={() => {
              set({ photoTool: 'add-window', alignMode: false });
              closeMenu();
            }}
          >
            {check(tool === 'add-window')}
            Add a missing window
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={tool === 'delete'}
            className={item}
            onClick={() => {
              set({ photoTool: 'delete', alignMode: false });
              closeMenu();
            }}
          >
            {check(tool === 'delete')}
            Remove a wrong one
          </button>
          <div role="separator" className="-mx-1 my-1 h-px bg-ink-700" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={settings.regularizeWindows}
            className={item}
            onClick={() => set({ settings: { ...settings, regularizeWindows: !settings.regularizeWindows } })}
          >
            {check(settings.regularizeWindows)}
            Snap windows to a neat grid
          </button>
        </div>
      )}
    </div>
  );
}

function safeRefresh(s: LiveSession) {
  try {
    return s.refresh().catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
