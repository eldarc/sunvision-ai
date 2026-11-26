/**
 * AlignCheck (alignment.md §4.3): "Does the blue outline sit on the building?"
 *
 * Draws the projected footprint wireframe of the active view over the photo. In align mode
 * every target-building vertex that projects inside the image gets a draggable handle;
 * dropping one creates an AlignPoint and the camera is re-solved live with
 * solveFromCorrespondences (lib/align.ts). "Auto-fit" runs autoAlignCamera (facade
 * regularity, jointly with the picked points). The fit error shown is the solver's own
 * reprojection rms, never an estimate of ours.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import type { AlignPoint, CameraParams, Vec2, Vec3 } from '../../schema/scene';
import { useStore } from '../../state/store';
import type { ViewInput } from '../../lib/views';
import { autoAlignCamera, solveFromCorrespondences } from '../../lib/align';
import { cameraBasis, worldToPixel } from '../../lib/camera';
import { candidatePlanes } from '../../lib/reconstruct';
import { facadePoint } from '../../lib/obstacles';
import { Segmented } from '../ui';
import { useThemeColors } from '../../lib/theme';

/** Touch screens get larger drag handles (44px hit area instead of 22px). */
const COARSE = '(pointer: coarse)';
function subscribeCoarse(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const m = window.matchMedia(COARSE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
const isCoarse = () => typeof window !== 'undefined' && !!window.matchMedia?.(COARSE).matches;

/* ------------------------------------------------------------------------------------------ */
/* Shared helpers (also used by the Inspector's Camera tab)                                     */
/* ------------------------------------------------------------------------------------------ */

export const alignOkKey = (sceneId: string, viewId: string) => `sv.alignOk.${sceneId}.${viewId}`;

export function isAlignConfirmed(sceneId: string, viewId: string): boolean {
  try {
    return sessionStorage.getItem(alignOkKey(sceneId, viewId)) === '1';
  } catch {
    return false;
  }
}

export function confirmAlign(sceneId: string, viewId: string) {
  try {
    sessionStorage.setItem(alignOkKey(sceneId, viewId), '1');
  } catch {
    /* storage unavailable: the banner just comes back next time */
  }
}

/**
 * Colour of the fit indicator: obs green ≤ 4 px, sun ≤ 10 px, red above.
 * `as: 'dot'` (default) gives the fill tokens; `as: 'text'` gives the AA text tokens, used where
 * the number itself is coloured (Inspector).
 */
export function fitColor(rms: number, as: 'dot' | 'text' = 'dot') {
  if (rms <= 4) return 'var(--color-obs)';
  if (rms <= 10) return as === 'text' ? 'var(--color-sun-400)' : 'var(--color-sun-500)';
  return as === 'text' ? 'var(--color-danger-text)' : 'var(--color-danger)';
}

/** Number of solver equations: 2 per ground point, 1 per vertical point. */
export const equationCount = (pts: AlignPoint[]) => pts.reduce((s, p) => s + (p.kind === 'ground' ? 2 : 1), 0);

/**
 * Parameters solveFromCorrespondences solves for a given number of equations (6+ → full pose,
 * 4–5 → orientation and FOV, 2–3 → heading and pitch). With no more equations than unknowns the
 * fit is exact by construction, so its rms (≈ 0 px) says nothing about the alignment yet.
 */
export function fitRedundancy(pts: AlignPoint[]): number {
  const eq = equationCount(pts);
  const unknowns = eq >= 6 ? 6 : eq >= 4 ? 4 : eq >= 2 ? 2 : 0;
  return eq - unknowns;
}

/** Dot colour for a fit chip: grey while the fit cannot show errors yet (no redundancy). */
export function fitChipColor(rms: number, pts: AlignPoint[], as: 'dot' | 'text' = 'dot') {
  return fitRedundancy(pts) > 0 ? fitColor(rms, as) : 'var(--color-ink-400)';
}

export const FIT_EXACT_HINT = 'Exact fit: no more equations than unknowns, so this number cannot reveal a bad pick yet. Add more corners.';

export interface SolveOutcome {
  camera: CameraParams;
  rms: number | null;
  changed: boolean;
  notes: string[];
}

/**
 * Resect the camera of `view` from `points`, always starting from `base` (so the result
 * does not drift with the order of edits). The returned camera carries
 * `alignment = { points, rms, method }` where rms is the solver's reprojection error at the
 * returned camera.
 */
export function solveViewCamera(view: ViewInput, base: CameraParams, points: AlignPoint[]): SolveOutcome {
  if (!points.length) {
    const { alignment: _drop, ...rest } = base;
    void _drop;
    return { camera: { ...rest, alignment: { points: [] } }, rms: null, changed: false, notes: [] };
  }
  const res = solveFromCorrespondences({ ...view, camera: base }, points, { hfovRange: base.hfovRange });
  const rms = Number.isFinite(res.terms.rms) ? res.terms.rms : null;
  const method = res.camera.alignment?.method ?? (res.changed ? 'resection' : 'resection-unchanged');
  return {
    camera: { ...res.camera, alignment: { points, rms: rms ?? undefined, method } },
    rms,
    changed: res.changed,
    notes: res.notes,
  };
}

/** Reprojection rms (px) of `points` at `camera` (no solve is applied). */
export function pointsRms(view: ViewInput, camera: CameraParams, points: AlignPoint[]): number | null {
  if (!points.length) return null;
  const r = solveFromCorrespondences({ ...view, camera }, points, { hfovRange: camera.hfovRange }).terms.rms0;
  return Number.isFinite(r) ? r : null;
}

const relaxProv = (p: CameraParams['provenance']): CameraParams['provenance'] =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === 'manual' ? 'inferred' : v])) as CameraParams['provenance'];

export interface AutoAlignOutcome {
  changed: boolean;
  camera: CameraParams;
  message: string;
  notes: string[];
}

/**
 * "Auto-align from windows": autoAlignCamera on the view's current camera. Picked points
 * (camera.alignment.points) join the fit as a reprojection term. With `relaxManual`, values
 * marked manual may move too (alignment.md §4.3: the picks, not the provenance, should hold
 * the camera); values that did not move keep their original provenance.
 */
export function autoAlignView(view: ViewInput, opts: { relaxManual?: boolean } = {}): AutoAlignOutcome {
  const cam = view.camera;
  const pts = cam.alignment?.points ?? [];
  const input: CameraParams = opts.relaxManual ? { ...cam, provenance: relaxProv(cam.provenance) } : cam;
  const res = autoAlignCamera({ ...view, camera: input }, { hfovRange: cam.hfovRange, points: pts });
  if (!res.changed) return { changed: false, camera: cam, message: res.notes[0] ?? 'Camera left unchanged.', notes: res.notes };
  const c = res.camera;
  const moved = {
    position: Math.hypot(c.position[0] - cam.position[0], c.position[1] - cam.position[1]) > 0.05,
    heading: Math.abs(c.heading - cam.heading) > 0.05,
    pitch: Math.abs(c.pitch - cam.pitch) > 0.05 || Math.abs(c.roll - cam.roll) > 0.05,
    hfov: Math.abs(c.hfov - cam.hfov) > 0.05,
    height: false,
  };
  const prov = { ...cam.provenance };
  for (const k of Object.keys(prov) as (keyof CameraParams['provenance'])[]) if (moved[k]) prov[k] = c.provenance[k];
  const rms = pointsRms(view, c, pts);
  const camera: CameraParams = {
    ...c,
    provenance: prov,
    alignment: pts.length ? { points: pts, rms: rms ?? undefined, method: 'regularity+points' } : cam.alignment,
  };
  const t = res.terms;
  const parts = [`Windows now line up within ${(t.spread * 100).toFixed(0)} cm (was ${(t.spread0 * 100).toFixed(0)} cm).`];
  if (rms != null) parts.push(`Picked corners fit to ${rms.toFixed(1)} px.`);
  return { changed: true, camera, message: parts.join(' '), notes: res.notes };
}

/**
 * Write a whole camera to any view, carrying its provenance (setViewCamera marks keys manual
 * otherwise). setViewCamera merges, so optional keys are passed explicitly: an absent
 * `alignment` (e.g. on Undo back to a camera without points) must clear the stored one.
 */
export function applyViewCamera(viewId: string, camera: CameraParams) {
  useStore.getState().setViewCamera(viewId, { ...camera, alignment: camera.alignment, notes: camera.notes, hfovRange: camera.hfovRange }, camera.provenance);
}

/* ------------------------------------------------------------------------------------------ */
/* Overlay                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface Viewport {
  s: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  view: ViewInput;
  sceneId: string;
  vp: Viewport;
  ready: boolean;
  /** Height used for each building (m), from the reconstruction. */
  heights: Record<string, number>;
}

const MAP = 'var(--color-map)';
/** The corner handles stay orange: the copy says "Drag each orange dot". */
const SUN = 'var(--color-sun-500)';
const OVERLAY_FONT = 'Inter, system-ui, sans-serif';

const btnBase =
  'inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40';
const btnSolid = clsx(btnBase, 'text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800');
const btnPrimary = clsx(btnBase, 'bg-accent-500 text-on-accent hover:bg-accent-600');

type DragState = { key: string; vertex: number; kind: AlignPoint['kind']; existingId?: string; px: Vec2; pointerId: number };

export default function AlignCheck({ view, sceneId, vp, ready, heights }: Props) {
  const alignMode = useStore((s) => s.alignMode);
  const layersAlignment = useStore((s) => s.layers.alignment);
  const set = useStore((s) => s.set);
  const tc = useThemeColors();
  const coarse = useSyncExternalStore(subscribeCoarse, isCoarse, () => false);
  const hitR = coarse ? 22 : 11;
  const W = view.image.width;
  const H = view.image.height;
  const cam = view.camera;

  // ---- banner state (per scene + view, session only) ---------------------------------------
  const [confirmed, setConfirmed] = useState(() => isAlignConfirmed(sceneId, view.id));
  useEffect(() => setConfirmed(isAlignConfirmed(sceneId, view.id)), [sceneId, view.id]);
  const showBanner = ready && !alignMode && !confirmed;
  const showWire = ready && (alignMode || showBanner || layersAlignment);

  // ---- align-mode working state --------------------------------------------------------------
  const baseRef = useRef<{ viewId: string; camera: CameraParams } | null>(null);
  // Undo stack: the camera (and solve base) before each change.
  const [history, setHistory] = useState<{ camera: CameraParams; base: CameraParams }[]>([]);
  const [kind, setKind] = useState<AlignPoint['kind']>('ground');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (alignMode) {
      if (!baseRef.current || baseRef.current.viewId !== view.id) {
        baseRef.current = { viewId: view.id, camera: structuredClone(cam) };
        setHistory([]);
        setNotes([]);
        setMsg(null);
      }
    } else {
      baseRef.current = null;
      setDrag(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignMode, view.id]);

  const points = useMemo(() => cam.alignment?.points ?? [], [cam.alignment]);
  const rms = cam.alignment?.rms;

  const pushHistory = () => {
    const base = baseRef.current?.camera ?? cam;
    setHistory((h) => [...h, { camera: cam, base }]);
  };

  const commit = (next: AlignPoint[]) => {
    const base = baseRef.current?.camera ?? cam;
    pushHistory();
    const out = solveViewCamera(view, base, next);
    applyViewCamera(view.id, out.camera);
    // The first note is the success summary; when the camera did not move it is the only explanation.
    setNotes(out.changed ? out.notes.slice(1) : out.notes);
    setMsg(null);
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    if (baseRef.current) baseRef.current = { viewId: view.id, camera: prev.base };
    applyViewCamera(view.id, prev.camera);
    setNotes([]);
    setMsg(null);
  };

  const autoFit = () => {
    setBusy(true);
    setMsg('Aligning from the window grid…');
    // Let the busy state paint; autoAlignCamera takes 60–190 ms.
    setTimeout(() => {
      try {
        const out = autoAlignView(view, { relaxManual: points.length > 0 });
        if (out.changed) {
          pushHistory();
          // Also on the store's stack, so the Camera tab's "Undo camera change" works after align mode closes.
          useStore.getState().pushCameraUndo(view.id);
          applyViewCamera(view.id, out.camera);
          // Joint fit result becomes the new base so further drags start from it.
          if (baseRef.current) baseRef.current = { viewId: view.id, camera: structuredClone(out.camera) };
        }
        setMsg(out.message);
      } catch (e) {
        setMsg(`Auto-fit failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    }, 16);
  };

  const done = () => {
    confirmAlign(sceneId, view.id);
    setConfirmed(true);
    set({ alignMode: false });
  };

  // ---- projection ---------------------------------------------------------------------------
  const geom = useMemo(() => {
    if (!ready) return null;
    const b = cameraBasis(cam, W, H);
    const proj = (p: Vec3) => worldToPixel(b, p);
    const hOf = (id: string) => heights[id] ?? view.footprints.find((f) => f.id === id)?.mapHeight ?? 10;
    const wire: { pts: [number, number][]; id: string; target: boolean }[] = [];
    for (const pl of candidatePlanes(view, cam)) {
      const h = hOf(pl.buildingId);
      const c = [facadePoint(pl, 0, 0), facadePoint(pl, pl.length, 0), facadePoint(pl, pl.length, h), facadePoint(pl, 0, h)].map(proj);
      if (c.every(Boolean)) wire.push({ pts: c as [number, number][], id: pl.buildingId + '#' + pl.edgeIndex, target: pl.buildingId === view.targetBuildingId });
    }
    const fp = view.footprints.find((f) => f.id === view.targetBuildingId);
    const th = hOf(view.targetBuildingId);
    const inside = (q: Vec2 | null): q is Vec2 => !!q && q[0] >= 0 && q[0] <= W && q[1] >= 0 && q[1] <= H;
    const vertices = (fp?.ring ?? []).map((v, i) => {
      const g = proj([v[0], v[1], 0]);
      const t = proj([v[0], v[1], th]);
      // Where to put an unplaced "vertical" handle: mid-height on the edge, else the first z inside the frame.
      let mid: Vec2 | null = null;
      for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const q = proj([v[0], v[1], th * f]);
        if (inside(q)) {
          mid = q;
          break;
        }
      }
      return { i, ground: g, top: t, mid, groundInside: inside(g) };
    });
    return { wire, vertices, proj };
  }, [ready, cam, W, H, heights, view]);

  if (!ready || !geom || !(vp.s > 0)) return null;
  const m2s = (x: number, y: number) => [vp.x + x * vp.s, vp.y + y * vp.s] as const;
  const toMedia = (e: React.PointerEvent): Vec2 => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement);
    const r = svg.getBoundingClientRect();
    return [Math.min(W, Math.max(0, (e.clientX - r.left - vp.x) / vp.s)), Math.min(H, Math.max(0, (e.clientY - r.top - vp.y) / vp.s))];
  };

  const placedFor = (vertex: number, k: AlignPoint['kind']) => points.find((p) => p.buildingId === view.targetBuildingId && p.vertex === vertex && p.kind === k);

  const dropPoint = (d: DragState, altKey: boolean) => {
    const k: AlignPoint['kind'] = d.existingId ? d.kind : altKey ? (d.kind === 'ground' ? 'vertical' : 'ground') : d.kind;
    const px: Vec2 = [Math.round(d.px[0] * 10) / 10, Math.round(d.px[1] * 10) / 10];
    const id = d.existingId ?? `${view.targetBuildingId}#${d.vertex}#${k}`;
    const next = points.filter((p) => p.id !== id && !(p.buildingId === view.targetBuildingId && p.vertex === d.vertex && p.kind === k));
    next.push({ id, px, buildingId: view.targetBuildingId, vertex: d.vertex, kind: k, source: 'manual' });
    commit(next);
  };

  const removePoint = (id: string) => commit(points.filter((p) => p.id !== id));

  const nudge = (e: React.KeyboardEvent, start: Vec2, vertex: number, k: AlignPoint['kind'], existingId?: string) => {
    const step = (e.shiftKey ? 10 : 2) / Math.max(vp.s, 1e-6);
    const d: Record<string, Vec2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) {
      e.preventDefault();
      const px: Vec2 = [Math.min(W, Math.max(0, start[0] + d[e.key][0])), Math.min(H, Math.max(0, start[1] + d[e.key][1]))];
      dropPoint({ key: '', vertex, kind: k, existingId, px, pointerId: -1 }, false);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && existingId) {
      e.preventDefault();
      removePoint(existingId);
    }
  };

  const handleEvents = (key: string, vertex: number, k: AlignPoint['kind'], start: Vec2, existingId?: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDrag({ key, vertex, kind: k, existingId, px: start, pointerId: e.pointerId });
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag || drag.key !== key || drag.pointerId !== e.pointerId) return;
      setDrag({ ...drag, px: toMedia(e) });
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!drag || drag.key !== key) return;
      const d = { ...drag, px: toMedia(e) };
      setDrag(null);
      // A plain click (no drag) does nothing; the handle only moves when dragged.
      if (Math.hypot(d.px[0] - start[0], d.px[1] - start[1]) * vp.s > 2) dropPoint(d, e.altKey);
    },
    onPointerCancel: () => setDrag(null),
    onKeyDown: (e: React.KeyboardEvent) => nudge(e, start, vertex, k, existingId),
  });

  const eq = equationCount(points);

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* touch-none while aligning: a finger drag moves the handle instead of scrolling the page */}
      <svg className={clsx('absolute inset-0 h-full w-full', alignMode && 'touch-none')} width={vp.w} height={vp.h} aria-hidden={!alignMode}>
        {alignMode && <rect x={0} y={0} width={vp.w} height={vp.h} fill="var(--color-ink-950)" opacity={0.25} className="pointer-events-auto" />}
        {showWire &&
          geom.wire.map((w) => {
            const pts = w.pts.map(([x, y]) => m2s(x, y).join(',')).join(' ');
            return (
              <g key={w.id}>
                {/* dark halo so the outline reads on bright and busy facades */}
                {w.target && <polygon points={pts} fill="none" stroke={tc.overlayStroke} strokeOpacity={0.7} strokeWidth={6} strokeLinejoin="round" />}
                <polygon
                  points={pts}
                  fill="none"
                  stroke={MAP}
                  strokeWidth={w.target ? 3 : 1.5}
                  strokeLinejoin="round"
                  strokeDasharray={w.target ? undefined : '5 4'}
                  opacity={w.target ? 1 : 0.75}
                />
              </g>
            );
          })}
        {alignMode && (
          <g>
            {/* residuals of placed points at the current camera */}
            {points.map((p) => {
              if (p.buildingId !== view.targetBuildingId) return null;
              const v = geom.vertices[p.vertex];
              if (!v) return null;
              const [sx, sy] = m2s(p.px[0], p.px[1]);
              let target: readonly [number, number] | null = null;
              if (p.kind === 'ground' && v.ground) target = m2s(v.ground[0], v.ground[1]);
              else if (p.kind === 'vertical' && v.ground && v.top && Math.abs(v.top[1] - v.ground[1]) > 1e-6) {
                const t = (p.px[1] - v.ground[1]) / (v.top[1] - v.ground[1]);
                target = m2s(v.ground[0] + t * (v.top[0] - v.ground[0]), p.px[1]);
              }
              return target && Number.isFinite(target[0]) && Number.isFinite(target[1]) ? <line key={'r' + p.id} x1={sx} y1={sy} x2={target[0]} y2={target[1]} stroke={tc.overlayText} strokeOpacity={0.85} strokeWidth={1} /> : null;
            })}
            {/* vertical edges of the target, so "anywhere on the corner edge" has a guide */}
            {kind === 'vertical' &&
              geom.vertices.map((v) =>
                v.ground && v.top ? (
                  <line key={'e' + v.i} x1={m2s(...v.ground)[0]} y1={m2s(...v.ground)[1]} x2={m2s(...v.top)[0]} y2={m2s(...v.top)[1]} stroke={SUN} strokeOpacity={0.5} strokeDasharray="3 3" />
                ) : null,
              )}
            {/* unplaced handles */}
            {geom.vertices.map((v) => {
              if (placedFor(v.i, kind)) return null;
              const at = kind === 'ground' ? (v.groundInside ? v.ground : null) : v.mid;
              if (!at) return null;
              const key = `new-${v.i}-${kind}`;
              const pos = drag?.key === key ? drag.px : at;
              const [x, y] = m2s(pos[0], pos[1]);
              return (
                <g key={key} tabIndex={0} role="button" aria-label={`Corner ${v.i + 1} of the building (${kind === 'ground' ? 'street level' : 'on the corner edge'}): drag onto the photo, or use the arrow keys`} className="pointer-events-auto cursor-grab touch-none outline-none focus-visible:[&>circle:last-child]:stroke-[3px]" {...handleEvents(key, v.i, kind, at)}>
                  <circle cx={x} cy={y} r={hitR} fill="transparent" />
                  <circle cx={x} cy={y} r={coarse ? 9 : 7} fill={SUN} stroke={tc.overlayStroke} strokeWidth={1.5} />
                </g>
              );
            })}
            {/* placed points */}
            {points.map((p) => {
              if (p.buildingId !== view.targetBuildingId) return null;
              const key = 'pt-' + p.id;
              const pos = drag?.key === key ? drag.px : p.px;
              const [x, y] = m2s(pos[0], pos[1]);
              return (
                <g key={key} tabIndex={0} role="button" aria-label={`Placed ${p.kind === 'ground' ? 'street-level' : 'edge'} point for corner ${p.vertex + 1}. Arrow keys move it, Delete removes it.`} className="pointer-events-auto cursor-grab touch-none outline-none" {...handleEvents(key, p.vertex, p.kind, p.px, p.id)}>
                  <circle cx={x} cy={y} r={hitR} fill="transparent" />
                  {p.kind === 'ground' ? (
                    <circle cx={x} cy={y} r={coarse ? 9 : 7} fill={SUN} stroke={tc.overlayText} strokeWidth={2} />
                  ) : (
                    <rect x={x - 6} y={y - 6} width={12} height={12} transform={`rotate(45 ${x} ${y})`} fill={SUN} stroke={tc.overlayText} strokeWidth={2} />
                  )}
                  <text x={x + 10} y={y - 8} fill={tc.overlayText} fontSize={11} fontWeight={600} fontFamily={OVERLAY_FONT} style={{ paintOrder: 'stroke' }} stroke={tc.overlayStroke} strokeWidth={3}>
                    {p.vertex + 1}
                  </text>
                </g>
              );
            })}
          </g>
        )}
      </svg>

      {/* ---- banner ---------------------------------------------------------------------- */}
      {showBanner && (
        // Phones: one compact row above the photo credit (short question, short labels), so most of the photo
        // stays free for tapping windows. Wider screens: the full sentence, centred under the building.
        <div className="pop-in pointer-events-auto absolute bottom-8 right-2 flex max-w-[calc(100%-1rem)] flex-nowrap items-center gap-2 rounded-xl bg-ink-900 py-1 pl-3 pr-1 text-xs text-paper shadow-panel pointer-coarse:[&_button]:h-11 sm:bottom-3 sm:left-1/2 sm:right-auto sm:w-max sm:max-w-[calc(100%-1.5rem)] sm:-translate-x-1/2 sm:gap-3 sm:py-1.5 sm:pr-1.5" role="region" aria-label="Alignment check">
          <svg width="14" height="10" viewBox="0 0 14 10" className="shrink-0" aria-hidden>
            <rect x="1" y="1" width="12" height="8" rx="1" fill="none" stroke={MAP} strokeWidth="1.75" />
          </svg>
          <span className="sm:hidden">Outline on the building?</span>
          <span className="hidden font-medium sm:inline">Does the blue outline sit on the building?</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                confirmAlign(sceneId, view.id);
                setConfirmed(true);
              }}
              aria-label="Looks right"
              className={btnSolid}
            >
              <span className="sm:hidden">Yes</span>
              <span className="hidden sm:inline">Looks right</span>
            </button>
            <button type="button" onClick={() => set({ alignMode: true })} className={btnPrimary}>
              Fix it
            </button>
          </div>
        </div>
      )}

      {/* ---- align-mode controls ----------------------------------------------------------- */}
      {alignMode && (
        <div className="pop-in pointer-events-auto absolute left-1/2 top-2 flex max-h-[calc(100%-1rem)] w-[min(600px,calc(100%-1rem))] -translate-x-1/2 flex-col overflow-y-auto rounded-xl bg-ink-900 text-xs text-ink-200 shadow-panel pointer-coarse:[&_button]:min-h-11" role="region" aria-label="Align the camera with building corners">
          <p className="px-3 pb-2 pt-2.5 leading-snug text-paper">Drag each orange dot onto the matching building corner at street level. Two corners are enough; four is better.</p>
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
            <Segmented
              size="xs"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'ground', label: 'Street-level corner', title: 'Where the corner meets the pavement (best). Hold Alt while dropping for the other kind.' },
                { value: 'vertical', label: 'Anywhere on the edge', title: 'Somewhere on the vertical corner edge, when its foot is hidden. Hold Alt while dropping for the other kind.' },
              ]}
            />
            <span className="num text-[11px] text-ink-400" aria-live="polite">
              {points.length} point{points.length === 1 ? '' : 's'} · {eq} equation{eq === 1 ? '' : 's'}
            </span>
            {typeof rms === 'number' && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-ink-800 px-2 text-[11px] text-paper" title={fitRedundancy(points) > 0 ? 'Reprojection error of your points at the solved camera (solveFromCorrespondences)' : FIT_EXACT_HINT}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: fitChipColor(rms, points) }} aria-hidden />
                <span className="num">Fit error {rms.toFixed(1)} px</span>
              </span>
            )}
            <div className="ml-auto flex gap-1">
              <button type="button" disabled={busy} onClick={autoFit} title="Self-calibrate from the window grid (autoAlignCamera), together with any corners you placed" className={btnSolid}>
                {busy ? 'Aligning…' : 'Auto-fit'}
              </button>
              <button type="button" disabled={!history.length || busy} onClick={undo} className={btnSolid}>
                Undo
              </button>
              <button type="button" onClick={done} className={btnPrimary}>
                Done
              </button>
            </div>
          </div>
          {(msg || notes.length > 0) && (
            <ul className={clsx('space-y-0.5 border-t border-ink-700 px-3 py-2 text-[11px] leading-snug', 'text-ink-300')} aria-live="polite">
              {msg && <li>{msg}</li>}
              {notes.map((n, i) => (
                <li key={i} className={n.startsWith('Residual') ? 'text-danger-text' : undefined}>
                  {n}
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-ink-700 px-3 py-2 text-[11px] leading-4 text-ink-400">Don't pick a corner you can't see. Placed points: arrow keys move, Delete removes.</p>
        </div>
      )}
    </div>
  );
}
