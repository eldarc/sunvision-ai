/**
 * Landing stage: the selected example's photo with its REAL recorded
 * Roboflow detections and floor rows drawn on top. Every number shown here is read
 * from the example's fixture files (analysis.json, scene.base.json); nothing is
 * hard-coded and no sun figure is shown, because none has been computed yet.
 *
 * Keep this module light: no three.js, maplibre or Inspector imports.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Detection, FacadeAnalysis, Vec2 } from '../../schema/scene';
import type { ExampleIndexEntry } from '../../lib/examples';
import { provMeta } from '../ui';
import { windowGrid } from '../../lib/align';
import { useThemeColors } from '../../lib/theme';

/* ------------------------------------------------------------------ */
/* Fixture data (module-level cache)                                   */
/* ------------------------------------------------------------------ */

/** The subset of scene.base.json the stage needs. */
export interface StageSceneBase {
  image: { width: number; height: number; attribution?: { sourceUrl?: string; creator?: string; license?: string } };
  footprints: { id: string; ring: Vec2[] }[];
  targetBuildingId: string;
  facadeEdgeIndex: number;
}

export interface StageData {
  /** null when the example has no recorded analysis.json (the loader's EMPTY_ANALYSIS case). */
  analysis: FacadeAnalysis | null;
  base: StageSceneBase | null;
}

const cache = new Map<string, Promise<StageData>>();

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    // Dev servers / static hosts may answer a missing file with index.html (status 200).
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Fetch (once per session) the example's analysis.json and scene.base.json. Never rejects. */
export function loadStageData(id: string): Promise<StageData> {
  let p = cache.get(id);
  if (!p) {
    p = Promise.all([fetchJson<FacadeAnalysis>(`examples/${id}/analysis.json`), fetchJson<StageSceneBase>(`examples/${id}/scene.base.json`)]).then(([analysis, base]) => ({
      analysis: analysis && Array.isArray(analysis.detections) ? withGridRows(analysis) : null,
      base,
    }));
    cache.set(id, p);
  }
  return p;
}

/**
 * Floor rows from the perspective-tolerant image window grid (lib/align.ts) rather than the
 * Python pipeline's 1-D row clustering, which merges rows on oblique corner views (NYC: 2 vs 8).
 */
function withGridRows(a: FacadeAnalysis): FacadeAnalysis {
  const grid = windowGrid(a.detections);
  const byId = new Map(a.detections.map((d) => [d.id, d]));
  const rows = grid.rows
    .filter((ids) => ids.length >= 2)
    .map((ids) => {
      const bs = ids.map((id) => byId.get(id)!.bbox);
      const ys = bs.map((b) => (b[1] + b[3]) / 2).sort((x, y) => x - y);
      return { yCenter: ys[ys.length >> 1], yMin: Math.min(...bs.map((b) => b[1])), yMax: Math.max(...bs.map((b) => b[3])), windowIds: ids };
    })
    .sort((r1, r2) => r2.yCenter - r1.yCenter)
    .map((r, index) => ({ index, ...r }));
  return rows.length ? { ...a, floorRows: rows } : a;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for checks against the fixtures)             */
/* ------------------------------------------------------------------ */

const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass name for an azimuth in degrees (clockwise from north). */
export function compass16(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS16[Math.round(d / 22.5) % 16];
}

/**
 * Compass azimuth (0–360°, clockwise from north) of the outward normal of edge
 * ring[i] → ring[i+1]. Same convention as lib/camera.ts `edgeOutwardNormal` and
 * Inspector.tsx `facadeAzimuth` (atan2(nx, ny)); the ring's winding is checked so a
 * clockwise ring still yields the outward side. Returns null for a degenerate edge.
 */
export function facadeAzimuthDeg(ring: Vec2[], edgeIndex: number): number | null {
  if (!ring || ring.length < 3 || edgeIndex < 0 || edgeIndex >= ring.length) return null;
  const a = ring[edgeIndex];
  const b = ring[(edgeIndex + 1) % ring.length];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-9) return null;
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    area2 += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area2 > 0;
  const nx = ccw ? dy : -dy;
  const ny = ccw ? -dx : dx;
  return ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
}

export interface StageFacts {
  windowCount: number;
  floorRowCount: number;
  /** Outward facade azimuth from the map footprint, degrees; null if unavailable. */
  azimuth: number | null;
  compass: string | null;
}

/** The numbers in the stage caption, computed only from fixture data. */
export function stageFacts(analysis: FacadeAnalysis | null, base: StageSceneBase | null): StageFacts {
  const windowCount = analysis ? analysis.detections.filter((d) => d.cls === 'window' && !d.deleted).length : 0;
  const floorRowCount = analysis?.floorRows?.length ?? 0;
  let azimuth: number | null = null;
  if (base) {
    const fp = base.footprints?.find((f) => f.id === base.targetBuildingId);
    if (fp) azimuth = facadeAzimuthDeg(fp.ring, base.facadeEdgeIndex);
  }
  return { windowCount, floorRowCount, azimuth, compass: azimuth == null ? null : compass16(azimuth) };
}

/** The caption under the stage: window count, floor rows and the facade's compass direction. */
export function stageCaption(f: StageFacts, hasAnalysis: boolean): string {
  if (!hasAnalysis) return 'No recorded detections yet';
  const parts = [`${f.windowCount} windows detected`, `${f.floorRowCount} floor rows`];
  if (f.azimuth != null && f.compass) parts.push(`facade faces ${f.compass} (${Math.round(f.azimuth) % 360}°)`);
  return parts.join(' · ');
}

/** Detected windows in reading order (top-to-bottom rows, then left-to-right). */
function windowsInReadingOrder(analysis: FacadeAnalysis): Detection[] {
  const wins = analysis.detections.filter((d) => d.cls === 'window' && !d.deleted);
  const rowOf = new Map<string, number>();
  for (const r of analysis.floorRows ?? []) for (const id of r.windowIds) rowOf.set(id, r.index);
  return wins.sort((p, q) => {
    const rp = rowOf.get(p.id);
    const rq = rowOf.get(q.id);
    if (rp != null && rq != null && rp !== rq) return rq - rp; // higher row index = higher on the facade
    const cy = (d: Detection) => (d.bbox[1] + d.bbox[3]) / 2;
    const cx = (d: Detection) => (d.bbox[0] + d.bbox[2]) / 2;
    if (rp == null || rq == null || rp !== rq) {
      const dy = cy(p) - cy(q);
      if (Math.abs(dy) > 1) return dy;
    }
    return cx(p) - cx(q);
  });
}

function pointsOf(d: Detection): string {
  const poly: Vec2[] =
    d.polygon && d.polygon.length >= 3
      ? d.polygon
      : [
          [d.bbox[0], d.bbox[1]],
          [d.bbox[2], d.bbox[1]],
          [d.bbox[2], d.bbox[3]],
          [d.bbox[0], d.bbox[3]],
        ];
  return poly.map((p) => `${p[0]},${p[1]}`).join(' ');
}

/* ------------------------------------------------------------------ */
/* Motion helpers                                                      */
/* ------------------------------------------------------------------ */

export function usePrefersReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setReduced(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

function useMediaQuery(q: string): boolean {
  const [hit, setHit] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setHit(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [q]);
  return hit;
}

/** True on touch-first devices (no hover, coarse pointer): copy says "Tap", hover previews are skipped. */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)');
}

/** Window overlay colour on the photo (theme-independent: the photo is the same in both themes). */
const PHOTO_LIT = '#f5b544';

/** Id of the window whose box is nearest to (x, y) in image px, within `tol`; null when none is. */
export function nearestBox(dets: Detection[], x: number, y: number, tol: number): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const d of dets) {
    const [x0, y0, x1, y1] = d.bbox;
    const dist = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
    if (dist <= bestD) {
      bestD = dist;
      best = d.id;
    }
  }
  return best;
}

const STAGE_MS = 3000;
const STAGE_LABELS = ['Photo', 'Windows found', 'Floors'] as const;
export type StageIndex = 0 | 1 | 2;

/** Scoped keyframes; every animation is disabled under prefers-reduced-motion. */
const STAGE_CSS = `
@keyframes sv-stage-zoom { from { transform: scale(1); } to { transform: scale(1.03); } }
@keyframes sv-stage-progress { from { transform: scaleX(var(--sv-p0)); } to { transform: scaleX(var(--sv-p1)); } }
@keyframes sv-stage-win { from { opacity: 0; } to { opacity: 1; } }
@keyframes sv-stage-sweep { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes sv-stage-fade { from { opacity: 0; } to { opacity: 1; } }
.sv-stage-win { animation: sv-stage-win 160ms ease-out both; }
.sv-stage-sweep { stroke-dasharray: 1; animation: sv-stage-sweep 300ms ease-out both; }
.sv-stage-fade { animation: sv-stage-fade 150ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .sv-stage-win, .sv-stage-sweep, .sv-stage-fade, .sv-stage-zoom, .sv-stage-progress { animation: none !important; }
  .sv-stage-sweep { stroke-dasharray: none; }
}
`;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface ExampleStageProps {
  example: ExampleIndexEntry | null;
  /** True until the first pointer or keyboard interaction with the stage or picker. */
  autoplay: boolean;
  /** Called on the first interaction with the stage (stops autoplay). */
  onInteract: () => void;
  /** A detected window was clicked (or activated with the keyboard). */
  onPickWindow: (exampleId: string, detectionId: string) => void;
  /** Disables window picking (e.g. while an example is opening). */
  busy?: boolean;
}

export default function ExampleStage({ example, autoplay, onInteract, onPickWindow, busy }: ExampleStageProps) {
  const reduced = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const colors = useThemeColors();
  const playing = autoplay && !reduced;
  const id = example?.id ?? null;

  const [data, setData] = useState<{ id: string; d: StageData } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadStageData(id).then((d) => alive && setData({ id, d }));
    return () => {
      alive = false;
    };
  }, [id]);
  const current = data && data.id === id ? data.d : null;
  const analysis = current?.analysis ?? null;
  const base = current?.base ?? null;
  const loaded = current != null;

  // Autoplay: Photo → Windows found → Floors, 3 s each, looping. Stops on interaction and
  // rests on "Windows found". Under reduced motion the stage is static on "Windows found".
  const [stage, setStage] = useState<StageIndex>(playing ? 0 : 1);
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      setStage((s) => ((s + 1) % 3) as StageIndex);
      if (stage === 2) setCycle((c) => c + 1);
    }, STAGE_MS);
    return () => clearTimeout(t);
  }, [playing, stage, cycle]);
  const wasPlaying = useRef(playing);
  const explicitStage = useRef(false);
  useEffect(() => {
    // Autoplay just stopped: rest on "Windows found" unless a stage chip was clicked.
    if (wasPlaying.current && !playing && !explicitStage.current) setStage(1);
    wasPlaying.current = playing;
  }, [playing]);

  const hasAnalysis = loaded && analysis != null;
  // With no recorded analysis, stages 2–3 are skipped.
  const shownStage: StageIndex = hasAnalysis ? stage : 0;

  const facts = useMemo(() => stageFacts(analysis, base), [analysis, base]);
  const windows = useMemo(() => (analysis ? windowsInReadingOrder(analysis) : []), [analysis]);
  const rows = useMemo(() => {
    if (!analysis) return [];
    const byId = new Map(analysis.detections.map((d) => [d.id, d]));
    return (analysis.floorRows ?? []).map((r) => {
      const ws = r.windowIds.map((w) => byId.get(w)).filter((d): d is Detection => !!d);
      const x0 = ws.length ? Math.min(...ws.map((d) => d.bbox[0])) : 0;
      const x1 = ws.length ? Math.max(...ws.map((d) => d.bbox[2])) : analysis.imageWidth;
      return { index: r.index, y: r.yCenter, x0, x1 };
    });
  }, [analysis]);

  const W = analysis?.imageWidth ?? base?.image.width ?? 4;
  const H = analysis?.imageHeight ?? base?.image.height ?? 3;

  // Window draw-in: 12 ms apart, capped at 700 ms in total. The counter ticks up to the real count.
  const step = windows.length ? Math.min(12, 700 / windows.length) : 0;
  const drawMs = Math.round(step * windows.length);
  const animateDraw = !reduced;
  const [count, setCount] = useState(0);
  const drawKey = `${id}:${cycle}`;
  useEffect(() => {
    if (shownStage < 1) {
      setCount(0);
      return;
    }
    const n = facts.windowCount;
    if (!animateDraw || drawMs <= 0) {
      setCount(n);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / (drawMs + 160));
      setCount(Math.round(n * k));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Re-run when the drawn set changes (new example or a new autoplay cycle), not on every stage tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey, shownStage >= 1, facts.windowCount, animateDraw, drawMs]);

  // Hover tooltip and roving keyboard focus over the windows.
  const frameRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const polyRefs = useRef<(SVGPolygonElement | null)[]>([]);
  useEffect(() => {
    setFocusIdx(0);
    setHover(null);
  }, [id]);

  const pick = useCallback(
    (detId: string) => {
      if (!id || busy) return;
      onInteract();
      onPickWindow(id, detId);
    },
    [id, busy, onInteract, onPickWindow],
  );

  const onWindowsKey = (e: ReactKeyboardEvent<SVGGElement>) => {
    if (!windows.length) return;
    let next = focusIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (focusIdx + 1) % windows.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (focusIdx - 1 + windows.length) % windows.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = windows.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(windows[focusIdx].id);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    onInteract();
    setFocusIdx(next);
    polyRefs.current[next]?.focus();
  };

  const interactive = shownStage >= 1 && windows.length > 0;
  const zoom = playing ? (shownStage === 0 ? 'anim' : 'held') : 'none';
  const credit = example?.credit;
  const sourceUrl = base?.image.attribution?.sourceUrl;
  const rowOfWindow = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of analysis?.floorRows ?? []) for (const w of r.windowIds) m.set(w, r.index);
    return m;
  }, [analysis]);

  const frameName = example ? `${example.title} · ${STAGE_LABELS[shownStage]}` : '';

  return (
    <figure className="m-0 w-full min-w-0" aria-label={example ? `${example.city}: ${example.title}` : 'Example photo'}>
      <style>{STAGE_CSS}</style>

      {/* Above the frame: its name (a frame label) on the left, the stage tabs on the right.
          On phones the tabs come first so the label still sits right on top of the frame. */}
      <div className="mb-1.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <span aria-hidden className="order-last w-full truncate text-[11px] leading-4 text-ink-400 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">
          {frameName}
        </span>
        {/* Stage tabs double as manual scrubbers. Segmented look: a grey well, the current one raised. */}
        <div className="inline-flex shrink-0 rounded-md bg-ink-800 p-0.5" role="group" aria-label="Stage">
          {STAGE_LABELS.map((label, i) => {
            const disabled = i > 0 && !hasAnalysis;
            const on = shownStage === i;
            return (
              <button
                key={label}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => {
                  explicitStage.current = true;
                  onInteract();
                  setStage(i as StageIndex);
                }}
                className={clsx(
                  'inline-flex h-6 items-center rounded-sm px-2 text-xs font-medium transition-colors pointer-coarse:min-h-11 pointer-coarse:px-3 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
                  on ? 'bg-ink-900 text-paper shadow-float' : 'text-ink-300 enabled:hover:text-paper',
                )}
              >
                {label}
                {i === 1 && shownStage >= 1 && hasAnalysis && <span className="num ml-1.5 text-ink-400">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={frameRef}
        className="relative aspect-[4/3] w-full overflow-hidden rounded-xs bg-ink-800 ring-1 ring-ink-700"
        // Pointing at the stage is an interaction: stop autoplay so the windows stay clickable. A finger
        // that only scrolls the page past the stage is not; a tap (click) is.
        onPointerDown={(e) => e.pointerType === 'mouse' && onInteract()}
        onPointerMove={autoplay ? (e) => e.pointerType === 'mouse' && onInteract() : undefined}
        onClick={autoplay ? onInteract : undefined}
        onPointerLeave={() => setHover(null)}
      >
        {example && (
          <div
            key={example.id}
            className={clsx('absolute inset-0 sv-stage-fade', zoom === 'anim' && 'sv-stage-zoom')}
            style={
              zoom === 'anim'
                ? { animation: `sv-stage-zoom ${STAGE_MS}ms linear both` }
                : { transform: zoom === 'held' ? 'scale(1.03)' : 'scale(1)', transition: reduced ? undefined : 'transform 300ms ease-out' }
            }
          >
            {/* The card image is already cached: it fills the frame until the full photo has loaded. */}
            {example.card && <img src={`examples/${example.id}/${example.card}`} alt="" aria-hidden className="absolute inset-0 h-full w-full select-none object-cover" draggable={false} />}
            <img
              src={`examples/${example.id}/${example.thumbnail ?? 'photo.jpg'}`}
              alt={`${example.title}, ${example.city}: street photograph used for this example`}
              className="absolute inset-0 h-full w-full select-none object-cover"
              draggable={false}
            />
            {hasAnalysis && (
              <svg
                className="absolute inset-0 h-full w-full"
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="xMidYMid slice"
                role={interactive ? 'group' : undefined}
                aria-hidden={interactive ? undefined : true}
                aria-label={interactive ? `${facts.windowCount} detected windows. Use the arrow keys to move between them and Enter to start there.` : undefined}
                // Windows can be a few px wide on a phone: a tap that misses every polygon picks the
                // nearest window within ~22 screen px (8 px with a mouse).
                onClick={
                  shownStage >= 1
                    ? (e) => {
                        if ((e.target as Element).tagName.toLowerCase() === 'polygon') return; // the polygon's own onClick
                        const ctm = e.currentTarget.getScreenCTM();
                        if (!ctm || !ctm.a) return;
                        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
                        const touch = (e.nativeEvent as PointerEvent).pointerType !== 'mouse';
                        const id = nearestBox(windows, p.x, p.y, (touch ? 22 : 8) / ctm.a);
                        if (id) pick(id);
                      }
                    : undefined
                }
              >
                {shownStage >= 1 && (
                  <g key={drawKey} onKeyDown={onWindowsKey}>
                    {windows.map((d, i) => {
                      const hot = hover?.id === d.id;
                      const row = rowOfWindow.get(d.id);
                      return (
                        <polygon
                          key={d.id}
                          ref={(el) => {
                            polyRefs.current[i] = el;
                          }}
                          points={pointsOf(d)}
                          className={clsx(animateDraw && 'sv-stage-win', 'cursor-pointer outline-none focus-visible:[stroke:var(--color-paper)] focus-visible:[stroke-width:3px]')}
                          style={animateDraw ? { animationDelay: `${Math.round(i * step)}ms` } : undefined}
                          // A bright amber in both themes: the photo underneath doesn't change with the theme
                          // (the light theme's --color-lit is darkened for the charts on cream panels).
                          fill={PHOTO_LIT}
                          fillOpacity={hot ? 0.45 : 0.3}
                          stroke={PHOTO_LIT}
                          strokeWidth={hot ? 2 : 1}
                          vectorEffect="non-scaling-stroke"
                          tabIndex={i === focusIdx ? 0 : -1}
                          role="button"
                          aria-label={`Start here: window ${i + 1} of ${windows.length}${row != null ? `, floor row ${row + 1} from the bottom` : ''}`}
                          onFocus={() => setFocusIdx(i)}
                          onPointerMove={(e) => {
                            const r = frameRef.current?.getBoundingClientRect();
                            if (r) setHover({ id: d.id, x: e.clientX - r.left, y: e.clientY - r.top });
                          }}
                          onPointerLeave={() => setHover((h) => (h?.id === d.id ? null : h))}
                          onClick={() => pick(d.id)}
                        />
                      );
                    })}
                  </g>
                )}
                {shownStage === 2 && (
                  <g key={`rows:${drawKey}`} aria-hidden pointerEvents="none">
                    {rows.map((r) => (
                      <line
                        key={r.index}
                        x1={r.x0}
                        x2={r.x1}
                        y1={r.y}
                        y2={r.y}
                        pathLength={1}
                        className="sv-stage-sweep"
                        stroke={colors.overlayText}
                        strokeOpacity={0.9}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        // A thin halo in the opposite colour keeps the line visible on light and dark facades.
                        style={{ filter: `drop-shadow(0 0 1px ${colors.overlayStroke})` }}
                      />
                    ))}
                  </g>
                )}
              </svg>
            )}
          </div>
        )}

        {/* Autoplay progress: a thin line along the frame's top edge, only while the stages cycle. */}
        {playing && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-0.5 bg-ink-950/40" aria-hidden>
            <div
              key={`${stage}:${cycle}`}
              className="sv-stage-progress absolute inset-0 origin-left bg-accent"
              style={{ ['--sv-p0' as string]: stage / 3, ['--sv-p1' as string]: (stage + 1) / 3, animation: `sv-stage-progress ${STAGE_MS}ms linear both` } as CSSProperties}
            />
          </div>
        )}

        {/* Hint chip once autoplay has stopped. */}
        {!playing && interactive && (
          <div className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-16px)] rounded-md bg-ink-900 px-2 py-1 text-[11px] font-medium leading-4 text-paper shadow-float">
            {coarse ? 'Tap any window to start there' : 'Click any window to start there'}
          </div>
        )}

        {/* Cursor tooltip. */}
        {hover && interactive && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-sm bg-ink-900 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-paper shadow-float"
            // Flip to the cursor's left near the right edge so the tooltip stays inside the frame.
            style={hover.x > (frameRef.current?.clientWidth ?? 0) - 96 ? { right: (frameRef.current?.clientWidth ?? 0) - hover.x + 12, top: hover.y + 12 } : { left: hover.x + 12, top: hover.y + 12 }}
          >
            Start here
          </div>
        )}

        {!loaded && example && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-ink-900/90 px-1.5 py-0.5 text-[11px] leading-4 text-ink-200 shadow-float">Loading recorded detections…</div>
        )}

        {credit && (
          <div className="absolute bottom-2 right-2 max-w-[calc(100%-16px)] truncate rounded-sm bg-ink-900/90 px-1.5 py-0.5 text-[11px] leading-4 text-ink-200 shadow-float">
            {sourceUrl ? (
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="rounded-xs hover:text-paper hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                Photo: {credit} · Wikimedia Commons
              </a>
            ) : (
              <>Photo: {credit} · Wikimedia Commons</>
            )}
          </div>
        )}
      </div>

      <figcaption className="mt-2 flex min-h-4 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-ink-400" aria-live="polite">
        {loaded && hasAnalysis && (
          <>
            <span className="inline-flex items-center gap-1" title={`${provMeta.observed.label}: Roboflow RF-DETR detections recorded for this photo`}>
              <ProvDot p="observed" />
              <span>
                <span className="num text-ink-200">{facts.windowCount}</span> windows detected
              </span>
            </span>
            <span aria-hidden>·</span>
            <span>
              <span className="num text-ink-200">{facts.floorRowCount}</span> floor rows
            </span>
            {facts.azimuth != null && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1" title={`${provMeta.map.label}: outward normal of the OpenStreetMap footprint edge`}>
                  <ProvDot p="map" />
                  <span>
                    facade faces <span className="text-ink-200">{facts.compass}</span> (<span className="num">{Math.round(facts.azimuth) % 360}°</span>)
                  </span>
                </span>
              </>
            )}
          </>
        )}
        {loaded && !hasAnalysis && <span>{stageCaption(facts, false)}</span>}
      </figcaption>
    </figure>
  );
}

function ProvDot({ p }: { p: 'observed' | 'map' }) {
  return <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: provMeta[p].color }} />;
}
