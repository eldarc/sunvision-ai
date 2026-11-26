/**
 * Simple-mode sunlight report: the answer-first card, the year sparkline,
 * "Is the model right?" and the link row.
 *
 * Every number here comes from the engine: `useDaily` (dailyExposure over the selected
 * windows) and `useAnnual` (the annual worker), or from the reconstruction. Nothing is
 * hard-coded. `part` lets the narrow layout put the answer first and the rest after the
 * photo, 3D view and day bar.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { useSimContext } from './SimContext';
import { useAnnual } from '../lib/useSim';
import { Dot, Drawer, GoAdvanced, Modal, Stepper } from './kit';
import { Btn, azimuthOf, compass16, floorLabel, fmtDayMonth, fmtDelta, fmtDur, fmtMin, heightSourceWords, monthName } from './ui';
import { Analytics, useSharedDaily } from './Timeline';
import Inspector from './Inspector';
import type { Provenance } from '../schema/scene';
import type { DailyExposureResult } from '../engine';

type Sim = ReturnType<typeof useSimContext>;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}

/** The selected windows that exist in the current geometry. */
function useSelectedIds(sim: Sim) {
  const sel = useStore((s) => s.selectedWindowIds);
  return useMemo(() => (sim ? sel.filter((id) => sim.geo.windows.some((w) => w.fw.id === id)) : []), [sim, sel]);
}

/** Tween a number over `ms` (instant under reduced motion). Always lands exactly on `target`. */
function useTween(target: number | null, ms = 200) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (target == null || start == null || start === target || prefersReducedMotion()) {
      from.current = target;
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const cur = start + (target - start) * (1 - (1 - k) * (1 - k));
      from.current = k < 1 ? cur : target;
      setV(k < 1 ? cur : target);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target, ms]);
  return v;
}

/**
 * Signed change of the answer after a room/model edit (not after a date change). Shown for 2s.
 * The baseline only moves on edits the user made, so background updates (a depth map arriving)
 * do not produce a delta.
 */
function useAnswerDelta(daily: DailyExposureResult | null, ids: string[]) {
  const sceneId = useStore((s) => s.scene?.id);
  const date = useStore((s) => s.date);
  const apartment = useStore((s) => s.apartment);
  const overrides = useStore((s) => s.overrides);
  const settings = useStore((s) => s.settings);
  const extraBuildings = useStore((s) => s.extraBuildings);
  const trees = useStore((s) => s.trees);
  const camera = useStore((s) => s.camera);
  const detections = useStore((s) => s.detections);
  const idsKey = ids.join('|');
  const inputs = [idsKey, apartment, overrides, settings, extraBuildings, trees, camera, detections] as const;
  const prev = useRef<{ sceneId?: string; date: string; value: number | null; inputs: readonly unknown[] } | null>(null);
  const [delta, setDelta] = useState<{ value: number; n: number } | null>(null);
  const value = daily ? daily.aggregate.directMinutes : null;

  useEffect(() => {
    const p = prev.current;
    const changedInputs = !!p && p.inputs.some((x, i) => x !== inputs[i]);
    if (p && p.sceneId === sceneId && p.date === date && changedInputs && p.value != null && value != null && p.inputs[0] !== '' && idsKey !== '') {
      setDelta((d) => ({ value: value - p.value!, n: (d?.n ?? 0) + 1 }));
    } else if (!p || p.sceneId !== sceneId || p.date !== date || !idsKey) {
      setDelta(null);
    }
    prev.current = { sceneId, date, value, inputs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daily, sceneId, date]);

  useEffect(() => {
    if (!delta) return;
    const t = setTimeout(() => setDelta(null), 2000);
    return () => clearTimeout(t);
  }, [delta]);
  return delta;
}

/** Narrow layout: the scrolling column is already a flat ink-900 panel split by hairlines, so the report adds no box of its own. */
const SURFACE = 'bg-ink-900';

/** A panel section: an h-8 title row (11px semibold) with an optional right-aligned action. */
function Section({ title, id, right, children, className }: { title: string; id?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={clsx('px-4 pb-4', className)}>
      <div className="flex h-8 items-center justify-between gap-2 pt-1">
        <h3 id={id} className="text-[11px] font-semibold leading-4 text-paper">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const linkCls = 'rounded-sm text-accent-300 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent';

/** Key/value rows, properties-panel style: an 11px grey label column and a 12px value column. */
const KV_GRID = 'grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5';
const KV_KEY = 'text-[11px] leading-5 text-ink-400';
const KV_VAL = 'min-w-0 text-xs leading-5 text-paper';

/** Legend key for sunlight data: the same amber as the bars and the day strip. */
function SunDot({ off }: { off?: boolean }) {
  return <span aria-hidden className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', off ? 'bg-shade-500' : 'bg-lit')} />;
}

/** Narrow-layout jump targets (section ids set by Workspace's SimpleNarrow). */
const JUMPS: [string, string][] = [
  ['sv-photo', 'Photo'],
  ['sv-twin', '3D'],
  ['sv-more', 'More'],
];
function jumpTo(el: Element | null) {
  el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/* -------------------------------------------------------------------------- */
/* Card 1: Your apartment                                                      */
/* -------------------------------------------------------------------------- */

/** Panel header of the report: "Your apartment" and its meta line. */
function AnswerShell({ framed, children }: { framed: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby="report-title" className={clsx('px-4 pb-4 pt-3', framed && SURFACE)}>
      <h3 id="report-title" className="text-[13px] font-semibold leading-5 text-paper">
        Your apartment
      </h3>
      {children}
    </section>
  );
}

export function AnswerCard({ roomControls }: { roomControls?: ReactNode }) {
  return <AnswerBody framed roomControls={roomControls} />;
}

function AnswerBody({ roomControls, framed }: { roomControls?: ReactNode; framed: boolean }) {
  const sim = useSimContext();
  const ids = useSelectedIds(sim);
  const daily = useSharedDaily(sim, ids);
  const date = useStore((s) => s.date);
  const set = useStore((s) => s.set);
  const delta = useAnswerDelta(daily, ids);
  const agg = daily?.aggregate ?? null;
  const shown = useTween(agg ? agg.directMinutes : null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useState(false);

  // Narrow layout: a 56px sticky summary appears once the card scrolls away.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (!sim) {
    return (
      <AnswerShell framed={framed}>
        <p className="mt-1 text-xs leading-5 text-ink-300">Building the 3D model…</p>
      </AnswerShell>
    );
  }

  const wins = sim.geo.windows.filter((w) => ids.includes(w.fw.id));
  const floor = sim.geo.apartment?.apartment.floor ?? wins[0]?.fw.floor;
  const az = wins[0] ? azimuthOf(wins[0].spec.normal) : null;
  const day = fmtDayMonth(date);
  const zero = agg != null && agg.directMinutes === 0;

  let mostly = '';
  if (agg && agg.directMinutes > 0) {
    if (agg.morningMinutes >= (2 / 3) * agg.directMinutes) mostly = 'mostly morning';
    else if (agg.afternoonMinutes >= (2 / 3) * agg.directMinutes) mostly = 'mostly afternoon';
    else mostly = 'spread over the day';
  }

  const hasSpan = agg?.firstDirect != null && agg.lastDirect != null;
  const blocker = agg?.blockers[0];
  const isBuilding = blocker && (blocker.kind === 'building' || blocker.kind === 'target-building');
  const blockerModel = isBuilding ? sim.recon.buildings[blocker.id] : undefined;
  const blockerSrc: Provenance | undefined = blockerModel?.height.source;
  const blockerLabel = blocker
    ? blocker.label === blocker.id && isBuilding
      ? blocker.kind === 'target-building'
        ? 'part of this building'
        : 'a neighbouring building'
      : blocker.label
    : '';

  return (
    <>
      {offscreen && agg && (
        // Sticky inside the scrolling column (not fixed to the window), so it always sits below the
        // top bar AND the phone notice row (with its "Add my key" button). -mb-14 cancels its height
        // (the column has no gaps), so showing it never shifts the content.
        <nav className="sticky top-0 z-30 -mb-14 flex h-14 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 pl-2 pr-2 lg:hidden" aria-label="Jump to">
          <button type="button" onClick={() => jumpTo(cardRef.current)} className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent" title="Back to the answer">
            <SunDot off={zero} />
            <span className="num text-[15px] font-semibold leading-5 tracking-[-0.01em] text-paper">{zero ? '0h' : fmtDur(agg.directMinutes)}</span>
            <span className="truncate text-xs text-ink-400">{fmtDayMonth(date, true)}</span>
            <span className="sr-only">, back to the answer</span>
          </button>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {JUMPS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => jumpTo(document.getElementById(id))} className="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs font-medium text-ink-200 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent">
                {label}
              </button>
            ))}
          </span>
        </nav>
      )}
      <div ref={cardRef}>
        <AnswerShell framed={framed}>
          {!ids.length ? (
            <p className="mt-1 text-xs leading-5 text-ink-300">Click a window in the photo or the 3D view to pick an apartment.</p>
          ) : (
            <>
              <p className="text-[11px] leading-4 text-ink-400">
                {floor != null && <span title="Counted from the ground floor (0).">{floorLabel(floor)}</span>}
                {floor != null && ' · '}
                {ids.length} window{ids.length === 1 ? '' : 's'}
                {az != null && (
                  <>
                    {' · faces '}
                    <span title={`${az.toFixed(0)}° from north`}>{compass16(az)}</span>
                  </>
                )}
              </p>

              {roomControls && <div className="mt-3">{roomControls}</div>}

              <div className="mt-4" aria-live="polite">
                {!agg ? (
                  <div className="shimmer h-12 w-36 rounded-md" aria-label="Working out the sun" />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-answer block whitespace-nowrap text-paper" aria-label={zero ? '0 hours' : fmtDur(agg.directMinutes)}>
                      {zero ? '0h' : fmtDur(shown ?? agg.directMinutes)}
                    </span>
                    {delta && (
                      <span
                        key={delta.n}
                        className={clsx(
                          'num pop-in inline-flex h-[18px] shrink-0 items-center rounded-sm px-1.5 text-[11px] font-medium leading-none',
                          Math.round(delta.value) > 0 ? 'bg-obs/15 text-obs' : Math.round(delta.value) < 0 ? 'bg-shade-400/15 text-shade-400' : 'bg-ink-700 text-ink-300',
                        )}
                        title="Change from before your last edit"
                      >
                        {fmtDelta(delta.value)}
                      </span>
                    )}
                  </div>
                )}
                {agg && (
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs leading-5 text-ink-300">
                    <SunDot off={zero} />
                    {zero ? `No direct sun on ${day}` : `of direct sun on ${day}`}
                    {mostly && <span className="text-ink-400">· {mostly}</span>}
                  </p>
                )}
              </div>

              {agg && (
                <>
                  {!hasSpan && <p className="mt-4 text-xs leading-5 text-ink-300">No direct sun today</p>}
                  {(hasSpan || blocker) && (
                    <dl className={clsx(KV_GRID, 'mt-4')}>
                      {hasSpan && (
                        <>
                          <dt className={KV_KEY}>First sun</dt>
                          <dd className={clsx(KV_VAL, 'num')}>{fmtMin(agg.firstDirect)}</dd>
                          <dt className={KV_KEY}>Last sun</dt>
                          <dd className={clsx(KV_VAL, 'num')}>{fmtMin(agg.lastDirect)}</dd>
                        </>
                      )}
                      {blocker && (
                        <>
                          <dt className={KV_KEY}>Main blocker</dt>
                          <dd className={KV_VAL}>
                            <span className="block first-letter:uppercase">{blockerLabel}</span>
                            {blockerSrc && (
                              <span className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-400">
                                {heightSourceWords[blockerSrc]}
                                <Dot p={blockerSrc} />
                              </span>
                            )}
                            {(blockerSrc === 'map' || blockerSrc === 'assumed') && (
                              <button type="button" className={clsx(linkCls, 'text-[11px] leading-5')} onClick={() => set({ addViewOpen: true })}>
                                Measure it with a photo
                              </button>
                            )}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                  {!blocker && <p className={clsx('text-xs leading-5 text-ink-300', hasSpan ? 'mt-1.5' : 'mt-1')}>Nothing modelled blocks the sun.</p>}
                  {/* What-if (scenario, layers, hypothetical buildings, trees) lives in Advanced. */}
                  <div className="mt-2">
                    <GoAdvanced label="Fine-tune…" tab="whatif" />
                  </div>
                </>
              )}
            </>
          )}
        </AnswerShell>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Year sparkline                                                              */
/* -------------------------------------------------------------------------- */

function YearSparkline() {
  const sim = useSimContext();
  const ids = useSelectedIds(sim);
  const annual = useAnnual(sim, ids, ids.length > 0);
  const date = useStore((s) => s.date);
  const set = useStore((s) => s.set);
  const [hover, setHover] = useState<number | null>(null);
  const [whole, setWhole] = useState(false);
  if (!ids.length) return null;

  const year = date.slice(0, 4);
  const curMonth = Number(date.slice(5, 7)) - 1;
  const vals = annual.result?.monthlyAvgDirectMinutes ?? null;
  const max = vals ? Math.max(60, ...vals.map((v) => v ?? 0)) : 60;
  const busy = annual.running || (!annual.result && !annual.error);

  return (
    <Section
      title="Across the year"
      id="year-title"
      right={
        <button type="button" className={clsx(linkCls, 'inline-flex min-h-7 items-center text-[11px] font-medium pointer-coarse:min-h-11')} onClick={() => setWhole(true)}>
          See the whole year
        </button>
      }
    >
      <div className="flex h-4 items-baseline justify-between gap-2 text-[11px] leading-4">
        <span className="text-ink-400">Avg. direct sun per day</span>
        {hover != null && vals && <span className="num text-paper">{`${monthName(hover)}: ${fmtDur(vals[hover])}`}</span>}
      </div>
      {annual.error ? (
        <p className="mt-2 text-xs text-danger-text">The year could not be computed: {annual.error}</p>
      ) : !vals ? (
        <div className="mt-3">
          <div className="shimmer h-16 rounded-md" />
          <p className="mt-1 text-[11px] text-ink-400">Working out the year…</p>
        </div>
      ) : (
        <>
          <div className={clsx('mt-3 flex h-16 items-end gap-[3px] border-b border-ink-700 transition-opacity', busy && 'opacity-50')} onMouseLeave={() => setHover(null)}>
            {vals.map((v, i) => (
              <button
                key={i}
                type="button"
                onClick={() => set({ date: `${year}-${String(i + 1).padStart(2, '0')}-15` })}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${monthName(i)}: ${v == null ? 'not sampled' : fmtDur(v)}. Show the 15th.`}
                title={`${monthName(i)}: ${v == null ? '—' : fmtDur(v)}`}
                className="group relative flex h-full flex-1 items-end rounded-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                {v == null ? (
                  <span className="block h-px w-full bg-ink-500" />
                ) : (
                  <span
                    className={clsx('block w-full rounded-t-xs transition-colors', v <= 0 ? 'bg-shade-500' : i === curMonth ? 'bg-lit' : 'bg-lit/45 group-hover:bg-lit/80')}
                    style={{ height: v > 0 ? `${Math.max(2, (v / max) * 64)}px` : '1px' }}
                  />
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-[3px] text-[11px] leading-3 text-ink-400" aria-hidden>
            {vals.map((_, i) => (
              <span key={i} className={clsx('num flex-1 text-center', i === curMonth && 'font-semibold text-paper')}>
                {monthName(i, true)[0]}
              </span>
            ))}
          </div>
          {busy && <p className="mt-1 text-[11px] text-ink-400">Working out the year…</p>}
        </>
      )}
      <Modal open={whole} onClose={() => setWhole(false)} title="The whole year" width={980}>
        <div className="-mx-4 -mb-4 -mt-4 overflow-x-auto">
          <div className="sm:min-w-[640px]">
            <Analytics ids={ids} daily={null} only="heatmap" />
          </div>
        </div>
      </Modal>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Card 2: Is the model right?                                                 */
/* -------------------------------------------------------------------------- */

function ModelCard({ className }: { className?: string }) {
  const sim = useSimContext();
  const scene = useStore((s) => s.scene);
  const overrides = useStore((s) => s.overrides);
  const setOverride = useStore((s) => s.setOverride);
  const set = useStore((s) => s.set);
  const ids = useSelectedIds(sim);
  const daily = useSharedDaily(sim, ids);
  if (!sim || !scene) return null;
  const target = scene.targetBuildingId;
  const m = sim.recon.buildings[target];
  if (!m) return null;
  const h = m.height;
  const ov = overrides[target];
  // No floor estimate (no window rows, no map levels): seed the stepper from height / floor height and say it is assumed.
  const levels = m.floors ? Math.round(m.floors.value) : Math.max(1, Math.round(h.value / (m.floorHeight?.value || 3)));
  const levelsSrc: Provenance = m.floors?.source ?? 'assumed';
  const neighbourMapHeights = (daily?.aggregate.blockers ?? []).some((b) => b.kind === 'building' && ['map', 'assumed'].includes(sim.recon.buildings[b.id]?.height.source ?? ''));

  return (
    <Section
      title="Is the model right?"
      id="model-title"
      className={className}
      right={
        ov && (
          <button type="button" className={clsx(linkCls, 'inline-flex min-h-7 items-center text-[11px] font-medium pointer-coarse:min-h-11')} onClick={() => setOverride(target, null)}>
            Use the estimate
          </button>
        )
      }
    >
      <dl className={KV_GRID}>
        <dt className={KV_KEY}>Building</dt>
        <dd className={clsx(KV_VAL, 'flex flex-wrap items-center gap-1.5')}>
          <span>
            ≈ <span className="num">{h.value.toFixed(1)}</span> m · <span className="num">{levels}</span> floors
          </span>
          <Dot p={h.source} />
          {levelsSrc !== h.source && <Dot p={levelsSrc} />}
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Stepper
          value={`${levels} floors`}
          onDec={() => setOverride(target, { floors: Math.max(1, levels - 1) })}
          onInc={() => setOverride(target, { floors: levels + 1 })}
          decLabel="One floor fewer"
          incLabel="One floor more"
          decDisabled={levels <= 1}
          incDisabled={levels >= 60}
        />
        <Btn kind="solid" onClick={() => set({ alignMode: true, leftTab: 'photo' })}>
          Check the fit
        </Btn>
      </div>
      {neighbourMapHeights && (
        <p className="mt-3 text-[11px] leading-4 text-ink-400">
          Some neighbour heights come from map data.{' '}
          <button type="button" className={linkCls} onClick={() => set({ addViewOpen: true })}>
            Add a photo of them
          </button>
        </p>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Rest: sparkline, footer, model card, links                                  */
/* -------------------------------------------------------------------------- */

function LinkRow() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-ink-700 px-4">
      <button type="button" className={clsx(linkCls, 'inline-flex min-h-7 items-center text-xs font-medium pointer-coarse:min-h-11')} onClick={() => setOpen(true)}>
        How sure is this?
      </button>
      <GoAdvanced label="All settings" />
      <Drawer open={open} onClose={() => setOpen(false)} title="How sure is this?">
        <Inspector />
      </Drawer>
    </div>
  );
}

const FOOTER = 'Clear-sky direct sun on a simplified 3D model. Not a professional daylight assessment.';

function YearAndFooter({ className }: { className?: string }) {
  const sim = useSimContext();
  const ids = useSelectedIds(sim);
  if (!ids.length) return null;
  return (
    <div className={className}>
      <YearSparkline />
      <p className="-mt-1 px-4 pb-4 text-[11px] leading-4 text-ink-400">{FOOTER}</p>
    </div>
  );
}

/**
 * The simple-mode report. `part="all"` is the 320px right column; the narrow layout renders
 * `part="answer"` first and `part="rest"` after the photo, the 3D view and the day bar.
 * `roomControls` is rendered inside card 1 (RoomControls' card variant, narrow layout only).
 */
export default function SunReport({ part = 'all', roomControls }: { part?: 'all' | 'answer' | 'rest'; roomControls?: ReactNode }) {
  if (part === 'answer') return <AnswerCard roomControls={roomControls} />;
  // Sections of one flat panel, divided by full-width hairlines (no nested cards).
  const rest = (first: boolean) => (
    <>
      <YearAndFooter className={first ? undefined : 'border-t border-ink-700'} />
      <ModelCard className="border-t border-ink-700 first:border-t-0" />
      <LinkRow />
    </>
  );
  if (part === 'rest')
    return (
      <div aria-label="More about this result" className={clsx(SURFACE, 'overflow-hidden')}>
        {rest(true)}
      </div>
    );
  return (
    <div className="h-full overflow-y-auto" aria-label="Sunlight report">
      <AnswerBody framed={false} roomControls={roomControls} />
      {rest(false)}
    </div>
  );
}
