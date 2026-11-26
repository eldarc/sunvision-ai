/**
 * Simple-mode room controls: Floor ↓/↑, Narrower/Wider, Shallower/Deeper,
 * plus a "Fine-tune" disclosure holding the remaining room sliders.
 *
 * `overlay` is the floating toolbar at the bottom of the 3D view (it also owns the keyboard
 * shortcuts); `card` is the stacked variant SunReport renders below 1024px.
 * All decisions are made by the pure helpers in lib/apartmentOps.ts; the room geometry
 * itself is built by lib/obstacles.ts from the resulting selection and parameters.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { useSimContext } from '../SimContext';
import { Slider } from '../ui';
import { Dot, FineTune, Stepper } from '../kit';
import { canNarrow, canWiden, DEPTH_MAX, DEPTH_MIN, floorLabel, INITIAL_MARGIN, narrow, shiftFloor, stepDepth, toWinLite, widen, type WinLite } from '../../lib/apartmentOps';

type Action = 'narrower' | 'wider' | 'floor-down' | 'floor-up' | 'shallower' | 'deeper';

const KEYS: Record<string, Action> = {
  '[': 'narrower',
  ']': 'wider',
  PageDown: 'floor-down',
  PageUp: 'floor-up',
  '-': 'shallower',
  '=': 'deeper',
};

/** Applies one room action to the current store state. Returns false when nothing changed. */
function applyAction(action: Action, lite: WinLite[], facadeLength: number | undefined): boolean {
  const st = useStore.getState();
  const sel = st.selectedWindowIds;
  const ap = st.apartment;
  if (!sel.length) return false;
  switch (action) {
    case 'wider':
    case 'narrower': {
      if (action === 'wider' ? !canWiden(sel, lite, ap.margin, facadeLength) : !canNarrow(sel, lite, ap.margin, INITIAL_MARGIN)) return false;
      const r = action === 'wider' ? widen(sel, lite, ap.margin, facadeLength) : narrow(sel, lite, ap.margin, INITIAL_MARGIN);
      st.set({ selectedWindowIds: r.selectedWindowIds, apartment: { ...ap, margin: r.margin } });
      return true;
    }
    case 'floor-up':
    case 'floor-down': {
      const next = shiftFloor(sel, lite, action === 'floor-up' ? 1 : -1);
      if (!next) return false;
      st.set({ selectedWindowIds: next });
      return true;
    }
    case 'deeper':
    case 'shallower': {
      const d = stepDepth(ap.depth, action === 'deeper' ? 1 : -1);
      if (d === ap.depth) return false;
      st.set({ apartment: { ...ap, depth: d } });
      return true;
    }
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t.closest('[role="dialog"]')) return true;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

/** Focus sits inside a scrollable panel (e.g. the Inspector): PageUp/PageDown belong to it. */
function inScrollPanel(t: EventTarget | null): boolean {
  if (typeof window === 'undefined' || !(t instanceof HTMLElement)) return false;
  for (let el: HTMLElement | null = t; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
}

/** The overlay is only shown from the lg breakpoint (TwinView wraps it in `hidden lg:flex`). */
const WIDE = '(min-width: 1024px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Slider label with the 6px provenance dot simple mode uses instead of the uppercase badge. */
const Assumed = ({ children }: { children: string }) => (
  <span className="inline-flex items-center gap-1.5">
    {children}
    <Dot p="assumed" />
  </span>
);

const fmtDepth = (d: number) => String(Math.round(d * 100) / 100);

export default function RoomControls({ variant = 'overlay' }: { variant?: 'overlay' | 'card' }) {
  const sim = useSimContext();
  const sel = useStore((s) => s.selectedWindowIds);
  const ap = useStore((s) => s.apartment);
  const set = useStore((s) => s.set);

  const lite = useMemo(() => (sim ? sim.geo.windows.map((w) => toWinLite(w.fw)) : []), [sim]);
  const apt = sim?.geo.apartment ?? null;
  const facadeLength = apt?.plane.length;

  // Keyboard shortcuts live on the overlay only, so the card variant never doubles them, and only
  // while the overlay is actually visible (below lg it is mounted but display:none).
  const ctx = useRef({ lite, facadeLength });
  ctx.current = { lite, facadeLength };
  const wide = useWide();
  const active = variant === 'overlay' && !!apt && wide;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const action = KEYS[e.key];
      if (!action) return;
      if ((e.key === 'PageUp' || e.key === 'PageDown') && inScrollPanel(e.target)) return;
      // PageUp/PageDown would otherwise scroll the page; swallow them even at a bound.
      e.preventDefault();
      applyAction(action, ctx.current.lite, ctx.current.facadeLength);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // The apartment can vanish (or lose its windows) between renders, e.g. when the scene or the
  // selection changes: render nothing rather than read through an empty list.
  if (!sim || !apt || !sel.length || !apt.windows?.length || !apt.apartment) return null;

  const a = apt.apartment;
  const k = apt.windows.length;
  const first = apt.windows[0].fw;
  const levels = sim.recon.buildings[first.buildingId]?.floors;
  const levelCount = levels && Number.isFinite(levels.value) ? Math.round(levels.value) : null;
  const winSource = first.source;
  const widthText = Number.isFinite(a.width) ? `${a.width.toFixed(1)} m` : '–';
  const depthOk = Number.isFinite(ap.depth);

  const floorDownOk = shiftFloor(sel, lite, -1) != null;
  const floorUpOk = shiftFloor(sel, lite, 1) != null;
  const widerOk = canWiden(sel, lite, ap.margin, facadeLength);
  const narrowerOk = canNarrow(sel, lite, ap.margin, INITIAL_MARGIN);

  const run = (action: Action) => () => void applyAction(action, lite, facadeLength);

  const floor = (
    <div title="Keys: PageDown floor down · PageUp floor up">
      <Stepper
        label={variant === 'card' ? 'Floor' : undefined}
        value={
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title="Counted from the ground floor (0).">
            <Dot p={winSource} />
            <span className="num">
              {Number.isFinite(a.floor) ? floorLabel(a.floor) : '–'}
              {levelCount != null ? ` of ${levelCount}` : ''}
            </span>
          </span>
        }
        onDec={run('floor-down')}
        onInc={run('floor-up')}
        decLabel="Floor ↓"
        incLabel="Floor ↑"
        decDisabled={!floorDownOk}
        incDisabled={!floorUpOk}
      />
    </div>
  );
  const width = (
    <div title="Keys: [ narrower · ] wider">
      <Stepper
        label="Width"
        value={
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Dot p="assumed" />
            <span className="num">
              {k} window{k === 1 ? '' : 's'} · {widthText}
            </span>
          </span>
        }
        onDec={run('narrower')}
        onInc={run('wider')}
        decLabel="Narrower"
        incLabel="Wider"
        decDisabled={!narrowerOk}
        incDisabled={!widerOk}
      />
    </div>
  );
  const depth = (
    <div title="Keys: - shallower · = deeper">
      <Stepper
        label="Depth"
        value={
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Dot p="assumed" />
            <span className="num">{depthOk ? `${fmtDepth(ap.depth)} m deep` : '–'}</span>
          </span>
        }
        onDec={run('shallower')}
        onInc={run('deeper')}
        decLabel="Shallower"
        incLabel="Deeper"
        decDisabled={!depthOk || ap.depth <= DEPTH_MIN}
        incDisabled={!depthOk || ap.depth >= DEPTH_MAX}
      />
    </div>
  );

  // The Apartment-tab sliders, same bounds (Inspector.tsx).
  const sliders = (
    <div className="space-y-1">
      <Slider label={<Assumed>Ceiling height</Assumed>} value={a.ceilingHeight} min={2.2} max={4.5} step={0.05} unit=" m" onChange={(v) => set({ apartment: { ...ap, ceilingHeight: v } })} />
      <Slider label={<Assumed>Sill height</Assumed>} value={ap.sillHeight} min={0} max={1.6} step={0.05} unit=" m" onChange={(v) => set({ apartment: { ...ap, sillHeight: v } })} />
      <Slider label="Internal walls" value={ap.partitions} min={0} max={4} step={1} onChange={(v) => set({ apartment: { ...ap, partitions: v } })} />
      <Slider label="Balcony above" value={ap.balconyDepth} min={0} max={3} step={0.1} unit=" m" onChange={(v) => set({ apartment: { ...ap, balconyDepth: v } })} />
      <p className="pt-1 text-[11px] leading-snug text-ink-400">Hypothetical room behind the selected windows, not the real floor plan.</p>
    </div>
  );

  if (variant === 'card') {
    return (
      <section aria-label="Room size" className="space-y-2 [&_button]:min-h-11 [&_button]:min-w-11">
        <p className="text-[11px] text-ink-400">Room size is a guess. Adjust it.</p>
        <div className="flex flex-col gap-2">
          {floor}
          {width}
          {depth}
        </div>
        <FineTune>{sliders}</FineTune>
      </section>
    );
  }

  // Floating bottom toolbar: one strip, groups split by 1px hairlines, the steppers'
  // labels small and grey beside their value wells. The Stepper primitive is styled locally.
  const sep = <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-ink-700" />;
  return (
    <div className="pointer-events-none flex max-w-[calc(100%-1.5rem)] flex-col items-center gap-2">
      <p className="rounded-md bg-ink-900 px-2 py-1 text-[11px] leading-4 text-ink-300 shadow-float">Room size is a guess. Adjust it.</p>
      <div
        role="group"
        aria-label="Room size"
        className="pointer-events-auto relative flex flex-wrap items-center justify-center gap-1 rounded-xl bg-ink-900 p-1 shadow-panel pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11 [&_[role=group]>span[id]]:pl-1.5 [&_[role=group]>span[id]]:text-[11px] [&_[role=group]>span[id]]:text-ink-400"
      >
        {floor}
        {sep}
        {width}
        {sep}
        {depth}
        {sep}
        {/* FineTune animates its panel with a transform, which would become the popover's containing block. */}
        <div className="[&>div>.fade-in]:[animation:none]! [&>div>.fade-in]:transform-none! [&>div>button]:ml-0 [&>div>button]:px-2">
          <FineTune>
            <div className="pop-in absolute bottom-full right-0 z-20 mb-2 w-72 rounded-xl bg-ink-900 px-3 pb-2 pt-1.5 text-left shadow-panel">{sliders}</div>
          </FineTune>
        </div>
      </div>
    </div>
  );
}

export { RoomControls };
