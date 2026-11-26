import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { useSimContext } from './SimContext';
import { useAnnual, useSunTimes } from '../lib/useSim';
import { Btn, SectionTitle, Segmented, Stat, fmtDayMonth, fmtDur, fmtMin } from './ui';
import { Chip } from './kit';
import { buildGeometry } from '../lib/obstacles';
import { SIM_YEAR_MAX, SIM_YEAR_MIN, buildObstacleIndex, dailyExposure, type AnnualResult, type DailyExposureResult } from '../engine';

/** The date inputs' range (the store clamps any other write to it as well). */
const DATE_MIN = `${SIM_YEAR_MIN}-01-01`;
const DATE_MAX = `${SIM_YEAR_MAX}-12-31`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Day-strip fills by sun state (tokens in index.css, so they follow the theme). */
const STATE_COLOR: Record<string, string> = {
  night: 'var(--color-night)',
  'facing-away': 'var(--color-away)',
  blocked: 'var(--color-unlit)',
  partial: 'color-mix(in oklab, var(--color-lit) 70%, var(--color-unlit))',
  direct: 'var(--color-lit)',
};

const dailyCache = new WeakMap<object, Map<string, DailyExposureResult | null>>();

/**
 * `useDaily` with a cache shared across components: the same dailyExposure call (5-min step) on the
 * same obstacle index, date and windows, so SunReport, DayBar and Timeline agree exactly and the
 * ray casting runs once per change instead of once per component.
 */
export function useSharedDaily(r: ReturnType<typeof useSimContext>, ids: string[]): DailyExposureResult | null {
  const scene = useStore((s) => s.scene);
  const date = useStore((s) => s.date);
  const key = ids.join('|');
  const index = r?.index;
  return useMemo(() => {
    if (!r || !scene || !index) return null;
    let m = dailyCache.get(index);
    if (!m) dailyCache.set(index, (m = new Map()));
    const k = `${scene.id}|${date}|${key}`;
    if (m.has(k)) return m.get(k) ?? null;
    const ws = r.geo.windows.filter((w) => ids.includes(w.fw.id)).map((w) => w.spec);
    let res: DailyExposureResult | null = null;
    try {
      res = ws.length ? dailyExposure(index, ws, date, { lat: scene.origin.lat, lon: scene.origin.lon, tz: scene.timezone }, 5) : null;
    } catch (e) {
      console.warn('[sunvisionai] daily exposure', e); // render-time: never throw
    }
    m.set(k, res);
    if (m.size > 32) m.delete(m.keys().next().value as string);
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, scene, date, key]);
}

export function useActiveWindowIds() {
  const sim = useSimContext();
  const sel = useStore((s) => s.selectedWindowIds);
  const scene = useStore((s) => s.scene);
  return useMemo(() => {
    if (!sim) return [] as string[];
    const valid = sel.filter((id) => sim.geo.windows.some((w) => w.fw.id === id));
    if (valid.length) return valid;
    return sim.geo.windows.filter((w) => w.fw.buildingId === scene?.targetBuildingId).map((w) => w.fw.id);
  }, [sim, sel, scene]);
}

export default function Timeline() {
  const scene = useStore((s) => s.scene)!;
  const date = useStore((s) => s.date);
  const minutes = useStore((s) => s.minutes);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const set = useStore((s) => s.set);
  const sel = useStore((s) => s.selectedWindowIds);
  const sim = useSimContext();
  const ids = useActiveWindowIds();
  const daily = useSharedDaily(sim, ids);
  const times = useSunTimes();
  const [expanded, setExpanded] = useState(false);
  const year = Number(date.slice(0, 4));
  usePlayback(playing, times);

  const agg = daily?.aggregate;
  const setDateMD = (m: number, d: number) => set({ date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  const month = Number(date.slice(5, 7));

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-2.5 lg:flex-row lg:items-stretch lg:gap-5">
        {/* date controls */}
        <div className="flex shrink-0 flex-col gap-2 lg:w-[268px]">
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" onClick={() => set({ playing: !playing })} className={clsx(ICON_BTN, playing ? 'bg-selected text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper')} aria-label={playing ? 'Pause' : 'Play daily animation'} title={playing ? 'Pause' : 'Play the day'}>
              {playing ? (
                <PauseIcon />
              ) : (
                <PlayIcon />
              )}
            </button>
            <input type="date" value={date} min={DATE_MIN} max={DATE_MAX} onChange={(e) => e.target.value && set({ date: e.target.value })} className={clsx(WELL, 'num px-2')} aria-label="Simulation date" />
            <select value={month} onChange={(e) => setDateMD(Number(e.target.value), 15)} className={clsx(WELL, 'select-well pl-2')} aria-label="Month">
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <select value={speed} onChange={(e) => set({ speed: Number(e.target.value) })} className={clsx(WELL, 'select-well num pl-2 text-ink-200')} aria-label="Playback speed">
              {[15, 30, 60, 120, 240].map((s) => (
                <option key={s} value={s}>{s / 60 >= 1 ? `${s / 60}h/s` : `${s}m/s`}</option>
              ))}
            </select>
          </div>
          <div className="max-w-full self-start overflow-x-auto">
            <div className={PRESET_GROUP}>
              <PresetBtn onClick={() => setDateMD(3, 20)} selected={date.endsWith('-03-20')}>Mar eq.</PresetBtn>
              <PresetBtn onClick={() => setDateMD(6, 21)} selected={date.endsWith('-06-21')}>Summer sol.</PresetBtn>
              <PresetBtn onClick={() => setDateMD(9, 22)} selected={date.endsWith('-09-22')}>Sep eq.</PresetBtn>
              <PresetBtn onClick={() => setDateMD(12, 21)} selected={date.endsWith('-12-21')}>Winter sol.</PresetBtn>
            </div>
          </div>
          <div className="num flex items-center gap-1.5 text-[11px] leading-4 text-ink-400">
            <SunIcon />
            <span>
              {fmtMin(times?.sunrise?.localMinutes)} – {fmtMin(times?.sunset?.localMinutes)} · noon {fmtMin(times?.solarNoon.localMinutes)} · {scene.timezone}
            </span>
          </div>
        </div>

        {/* time strip */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 pb-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="num text-[15px] font-semibold leading-5 tracking-[-0.01em] text-paper">{fmtMin(minutes)}</span>
            <span className="min-w-0 text-[11px] text-ink-400">
              {sel.length ? `${ids.length} selected window${ids.length > 1 ? 's' : ''}` : `all ${ids.length} windows on the photographed facade`} · 5-min sampling · 12 rays/window
            </span>
          </div>
          <DayStrip daily={daily} minutes={minutes} onChange={(m) => set({ minutes: m })} sunrise={times?.sunrise?.localMinutes} sunset={times?.sunset?.localMinutes} />
        </div>

        {/* day stats */}
        <div className="grid shrink-0 grid-cols-2 content-center gap-x-4 gap-y-3 sm:grid-cols-4 lg:w-[400px] lg:border-l lg:border-ink-700 lg:pl-5">
          <Stat label="Direct sun" value={fmtDur(agg?.directMinutes)} sub={agg ? `${Math.round(agg.directFractionOfDaylight * 100)}% of daylight` : 'select windows'} accent />
          <Stat label="Morning / aft." value={agg ? `${fmtDur(agg.morningMinutes)}` : '—'} sub={agg ? `/ ${fmtDur(agg.afternoonMinutes)} after noon` : undefined} />
          <Stat label="First – last" value={agg?.firstDirect != null ? `${fmtMin(agg.firstDirect)}` : '—'} sub={agg?.lastDirect != null ? `until ${fmtMin(agg.lastDirect)}` : 'no direct sun'} />
          <Stat label="Main blocker" value={agg?.blockers[0] ? fmtDur(agg.blockers[0].minutes / Math.max(1, ids.length)) : '—'} sub={agg?.blockers[0]?.label ?? 'none modelled'} />
        </div>
      </div>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-ink-700 px-3 py-1">
        <span className="min-w-0 text-[11px] leading-4 text-ink-400">Potential direct sunlight under clear skies on the modelled geometry. Not a weather forecast or measured indoor brightness.</span>
        <Btn onClick={() => setExpanded(!expanded)} active={expanded}>
          {expanded ? 'Hide analytics' : 'Annual analytics'}
          <Chevron up={!expanded} />
        </Btn>
      </div>
      {expanded && <Analytics ids={ids} daily={daily} onClose={() => setExpanded(false)} />}
    </div>
  );
}

/** Advances `minutes` while `playing`, looping from just before sunrise to just after sunset. */
function usePlayback(playing: boolean, times: ReturnType<typeof useSunTimes>) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (t: number) => {
      if (last.current != null) {
        const dt = (t - last.current) / 1000;
        const s = useStore.getState();
        let m = s.minutes + dt * s.speed;
        if (times?.sunset && times.sunrise && m > times.sunset.localMinutes + 20) m = Math.max(0, times.sunrise.localMinutes - 20);
        if (m >= 1440) m -= 1440;
        s.set({ minutes: m });
      }
      last.current = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, times]);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Season chips for a year and hemisphere: southern latitudes swap winter/summer and spring/autumn. */
export function seasonDates(year: number, lat: number): { key: string; label: string; date: string }[] {
  const n = (m: number, d: number) => `${year}-${pad2(m)}-${pad2(d)}`;
  const dec = n(12, 21), mar = n(3, 20), jun = n(6, 21), sep = n(9, 22);
  const south = lat < 0;
  return [
    { key: 'winter', label: 'Winter', date: south ? jun : dec },
    { key: 'spring', label: 'Spring', date: south ? sep : mar },
    { key: 'summer', label: 'Summer', date: south ? dec : jun },
    { key: 'autumn', label: 'Autumn', date: south ? mar : sep },
  ];
}

/** 28px icon button (44px under a coarse pointer). */
const ICON_BTN = 'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11';
/** Input-like grey well (date, selects). */
const WELL = 'min-h-7 rounded-md bg-ink-800 py-1 text-xs text-paper hover:bg-ink-700 focus-visible:outline-1 focus-visible:outline-accent pointer-coarse:min-h-11';
/** Date presets: a segmented-looking group of toggle buttons (aria-pressed, no radio semantics). */
const PRESET_GROUP = 'inline-flex shrink-0 items-center rounded-md bg-ink-800 p-0.5';

function PresetBtn({ selected, onClick, title, children }: { selected: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={title}
      className={clsx(
        'inline-flex h-6 items-center whitespace-nowrap rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11',
        selected ? 'bg-ink-900 text-paper shadow-float' : 'text-ink-300 hover:text-paper',
      )}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="1.5" width="2.5" height="9" rx="0.6" fill="currentColor" />
      <rect x="7" y="1.5" width="2.5" height="9" rx="0.6" fill="currentColor" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </svg>
  );
}
function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className={clsx('transition-transform motion-reduce:transition-none', up && 'rotate-180')}>
      <path d="M1.5 2.75 4 5.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** Legend key for sunlight data: the same amber as the day strip. */
function SunDot() {
  return <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-lit" />;
}

/** Opens the native date picker of a (visually hidden) date input. */
function openDatePicker(el: HTMLInputElement | null) {
  if (!el) return;
  try {
    if (typeof el.showPicker === 'function') {
      el.showPicker();
      return;
    }
  } catch {
    /* showPicker can throw without a user gesture or in iframes; fall back to focus */
  }
  el.focus();
  el.click();
}

function HiddenDateInput({ inputRef, date, onDate }: { inputRef: React.RefObject<HTMLInputElement | null>; date: string; onDate: (d: string) => void }) {
  return (
    <input
      ref={inputRef}
      type="date"
      value={date}
      min={DATE_MIN}
      max={DATE_MAX}
      onChange={(e) => e.target.value && onDate(e.target.value)}
      tabIndex={-1}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-full h-0 w-0 opacity-0"
    />
  );
}

/**
 * Simple-mode timeline, 88px: play, season chips, date picker, clock, two stats, then the day strip.
 *
 * `variant="dock"` is the phone layout, docked at the bottom of the screen for the thumb: one 44px
 * row (play · clock · date · direct sun) over a 44px-tall day strip. The season chips and the date
 * picker move into a small sheet that opens from the date button.
 */
export function DayBar({ variant = 'bar' }: { variant?: 'bar' | 'dock' }) {
  const scene = useStore((s) => s.scene)!;
  const date = useStore((s) => s.date);
  const minutes = useStore((s) => s.minutes);
  const playing = useStore((s) => s.playing);
  const set = useStore((s) => s.set);
  const sel = useStore((s) => s.selectedWindowIds);
  const sim = useSimContext();
  const ids = useActiveWindowIds();
  const daily = useSharedDaily(sim, ids);
  const times = useSunTimes();
  const dateRef = useRef<HTMLInputElement>(null);
  usePlayback(playing, times);

  const year = Number(date.slice(0, 4));
  const today = localToday();
  const seasons = seasonDates(year, scene.origin.lat);
  const agg = daily?.aggregate;
  const selected = sel.some((id) => ids.includes(id));
  const directTitle = selected ? 'Direct sun on the selected windows on this day' : 'Average direct sun across the windows of the photographed facade';
  const playBtn = (big: boolean) => (
    <button
      type="button"
      onClick={() => set({ playing: !playing })}
      className={clsx(
        big ? 'grid h-11 w-11 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent' : ICON_BTN,
        playing ? 'bg-selected text-paper' : big ? 'bg-ink-800 text-paper hover:bg-ink-700' : 'text-ink-200 hover:bg-ink-800 hover:text-paper',
      )}
      aria-label={playing ? 'Pause' : 'Play the day'}
      title={playing ? 'Pause' : 'Play the day'}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
  const strip = (tall: boolean) => <DayStrip compact tall={tall} daily={daily} minutes={minutes} onChange={(m) => set({ minutes: m })} sunrise={times?.sunrise?.localMinutes} sunset={times?.sunset?.localMinutes} />;

  if (variant === 'dock')
    return (
      <div className="flex flex-col gap-1.5 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-0 items-center gap-2">
          {playBtn(true)}
          <span className="num text-[17px] font-semibold leading-6 tracking-[-0.01em] text-paper" aria-label={`Time ${fmtMin(minutes)}`}>
            {fmtMin(minutes)}
          </span>
          <DateSheet date={date} today={today} seasons={seasons} onDate={(d) => set({ date: d })} />
          <div className="ml-auto min-w-0 text-right" title={directTitle}>
            <div className="text-[11px] leading-4 text-ink-400">Direct sun</div>
            <div className="num flex items-center justify-end gap-1.5 text-[13px] font-semibold leading-5 text-paper">
              <SunDot />
              {fmtDur(agg?.directMinutes)}
            </div>
          </div>
        </div>
        {strip(true)}
        <div className="h-3" aria-hidden />
      </div>
    );

  return (
    <div className="flex h-full min-h-[88px] flex-col justify-center gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {playBtn(false)}
        <span className="num w-12 text-[15px] font-semibold leading-5 tracking-[-0.01em] text-paper" aria-label={`Time ${fmtMin(minutes)}`}>
          {fmtMin(minutes)}
        </span>
        <div className="relative flex items-center">
          <button
            type="button"
            onClick={() => openDatePicker(dateRef.current)}
            aria-label="Pick a date"
            title="Pick a date"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-800 pl-2 pr-2.5 text-xs text-paper transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11"
          >
            <span className="text-ink-400">
              <CalendarIcon />
            </span>
            <span className="num whitespace-nowrap">{fmtDayMonth(date)}</span>
          </button>
          <HiddenDateInput inputRef={dateRef} date={date} onDate={(d) => set({ date: d })} />
        </div>
        <div className={PRESET_GROUP} role="group" aria-label="Season">
          <PresetBtn title={fmtDayMonth(today)} selected={date === today} onClick={() => set({ date: today })}>Today</PresetBtn>
          {seasons.map((s) => (
            <PresetBtn key={s.key} title={fmtDayMonth(s.date)} selected={date === s.date} onClick={() => set({ date: s.date })}>{s.label}</PresetBtn>
          ))}
        </div>
        <dl className="ml-auto flex items-center gap-5 pl-2">
          <div className="flex items-baseline gap-2" title={directTitle}>
            <dt className="text-[11px] text-ink-400">Direct sun</dt>
            <dd className="num flex items-center gap-1.5 self-center text-xs font-semibold text-paper">
              <SunDot />
              {fmtDur(agg?.directMinutes)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2" title="First and last direct sun on these windows">
            <dt className="text-[11px] text-ink-400">Sun between</dt>
            <dd className="num text-xs font-medium text-paper">{agg?.firstDirect != null && agg.lastDirect != null ? `${fmtMin(agg.firstDirect)}–${fmtMin(agg.lastDirect)}` : '—'}</dd>
          </div>
        </dl>
      </div>
      {strip(false)}
      <div className="h-3" aria-hidden />
    </div>
  );
}

/** Phone date control: "15 Apr ▾" opens a sheet with the season chips and the native date picker. */
function DateSheet({ date, today, seasons, onDate }: { date: string; today: string; seasons: { key: string; label: string; date: string }[]; onDate: (d: string) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  // Keep the sheet on screen: anchored to the button, it would run past the right edge when the
  // button sits mid-dock. Shift it left so it stays 12 px inside the viewport.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    // `left`, not transform: the sheet-in animation owns transform.
    el.style.left = '';
    const r = el.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 12);
    const shift = over > 0 ? Math.min(over, r.left - 12) : 0;
    if (shift > 0) el.style.left = `${-shift}px`;
  }, [open]);
  const pick = (d: string) => {
    onDate(d);
    setOpen(false);
    btn.current?.focus();
  };
  const opts = [{ key: 'today', label: 'Today', date: today }, ...seasons];
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-11 items-center gap-1.5 rounded-md bg-ink-800 px-2.5 text-xs font-medium text-paper transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        title="Change the date"
      >
        <span className="text-ink-400">
          <CalendarIcon />
        </span>
        <span className="btn-label num whitespace-nowrap">{fmtDayMonth(date, true)}</span>
        <span className="sr-only">, change the date</span>
      </button>
      {open && (
        <div ref={panel} id={id} role="group" aria-label="Date" className="sheet-in absolute bottom-[calc(100%+8px)] left-0 z-40 w-[min(19rem,calc(100vw-1.5rem))] rounded-xl bg-ink-900 p-3 shadow-panel">
          <div className="mb-2 text-[11px] font-semibold leading-4 text-paper">Season</div>
          <div className="flex flex-wrap gap-1.5">
            {opts.map((o) => (
              <span key={o.key} title={fmtDayMonth(o.date)}>
                <Chip selected={date === o.date} onClick={() => pick(o.date)}>
                  {o.label}
                  <span className="sr-only">, {fmtDayMonth(o.date)}</span>
                </Chip>
              </span>
            ))}
          </div>
          <div className="relative -mx-3 mt-3 border-t border-ink-700 px-1.5 pt-1.5">
            <button
              type="button"
              onClick={() => openDatePicker(dateRef.current)}
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs font-medium text-paper hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="text-ink-400">
                <CalendarIcon />
              </span>
              Pick a date…
              <span className="num ml-auto text-[11px] text-ink-400">{date}</span>
            </button>
            <HiddenDateInput inputRef={dateRef} date={date} onDate={pick} />
          </div>
        </div>
      )}
    </div>
  );
}

const COMPACT_COLOR: Record<string, string> = { night: 'var(--color-night)', 'facing-away': 'color-mix(in oklab, var(--color-shade-500) 40%, var(--color-ink-900))', blocked: 'var(--color-shade-500)', partial: 'var(--color-lit)', direct: 'var(--color-lit)' };

/**
 * The day strip: a slider over the day (role="slider", arrows ±10 min, Shift ±60, Home/End).
 * `tall`: a 44px touch target around a 32px strip (phone dock).
 */
function DayStrip({ daily, minutes, onChange, sunrise, sunset, compact = false, tall = false }: { daily: DailyExposureResult | null; minutes: number; onChange: (m: number) => void; sunrise?: number; sunset?: number; compact?: boolean; tall?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const tl = daily?.aggregate.timeline ?? [];
  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1439, ((e.clientX - r.left) / r.width) * 1440)));
  };
  return (
    <div
      ref={ref}
      className={clsx('relative cursor-ew-resize touch-none select-none rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent', tall ? 'h-11' : compact ? 'h-6' : 'h-11')}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => e.buttons && pick(e)}
      role="slider"
      aria-label="Time of day"
      aria-valuemin={0}
      aria-valuemax={1439}
      aria-valuenow={Math.round(minutes)}
      aria-valuetext={fmtMin(minutes)}
      tabIndex={0}
      onKeyDown={(e) => {
        let m: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') m = Math.min(1439, minutes + (e.shiftKey ? 60 : 10));
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') m = Math.max(0, minutes - (e.shiftKey ? 60 : 10));
        else if (e.key === 'PageUp') m = Math.min(1439, minutes + 60);
        else if (e.key === 'PageDown') m = Math.max(0, minutes - 60);
        else if (e.key === 'Home') m = 0;
        else if (e.key === 'End') m = 1439;
        if (m != null) {
          e.preventDefault();
          onChange(m);
        }
      }}
    >
      <div className={clsx('absolute inset-x-0 overflow-hidden rounded-md bg-ink-800 ring-1 ring-ink-700', tall ? 'inset-y-1.5' : 'inset-y-0')}>
        <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 1440 44" aria-hidden>
          {tl.map((s, i) => {
            const step = daily!.stepMinutes;
            const x = s.localMinutes - step / 2;
            return <rect key={i} x={x} y={0} width={step + 0.6} height={44} style={{ fill: (compact ? COMPACT_COLOR : STATE_COLOR)[s.state] }} opacity={s.state === 'partial' ? 0.5 + s.litFraction * 0.5 : 1} />;
          })}
          {/* lit fraction curve */}
          {tl.length > 0 && <polyline fill="none" style={{ stroke: 'var(--color-sun-300)' }} strokeWidth={1.2} vectorEffect="non-scaling-stroke" points={tl.map((s) => `${s.localMinutes},${42 - s.litFraction * 36}`).join(' ')} opacity={0.9} />}
          {[3, 6, 9, 12, 15, 18, 21].map((h) => (
            <line key={h} x1={h * 60} x2={h * 60} y1={0} y2={44} style={{ stroke: 'var(--color-paper)' }} strokeOpacity={0.1} vectorEffect="non-scaling-stroke" />
          ))}
          {sunrise != null && <line x1={sunrise} x2={sunrise} y1={0} y2={44} style={{ stroke: 'var(--color-sun-500)' }} strokeOpacity={0.75} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
          {sunset != null && <line x1={sunset} x2={sunset} y1={0} y2={44} style={{ stroke: 'var(--color-sun-500)' }} strokeOpacity={0.75} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className={clsx('pointer-events-none absolute w-0.5 rounded-full bg-paper shadow-[0_0_0_1.5px_var(--color-ink-900)]', tall ? 'inset-y-0.5' : 'inset-y-[-3px]')} style={{ left: `calc(${(minutes / 1440) * 100}% - 1px)` }} />
      <div className={clsx('pointer-events-none absolute left-0 right-0 flex justify-between px-0.5 text-[11px] leading-3 text-ink-400', tall ? 'top-[calc(100%-5px)]' : 'top-full mt-1')}>
        {(compact ? ['00', '06', '12', '18', '24'] : ['00', '03', '06', '09', '12', '15', '18', '21', '24']).map((h) => (
          <span key={h} className="num">{h}</span>
        ))}
      </div>
      {!daily && <div className="absolute inset-0 grid place-items-center text-[11px] leading-none text-ink-400">No windows to evaluate</div>}
    </div>
  );
}

/** Annual analytics panel. `only="heatmap"` shows the heatmap alone (simple mode's "See the whole year"). */
export function Analytics({ ids, daily, only }: { ids: string[]; daily: DailyExposureResult | null; onClose?: () => void; only?: 'heatmap' }) {
  const sim = useSimContext();
  const annual = useAnnual(sim, ids, true);
  const scene = useStore((s) => s.scene)!;
  const store = useStore();
  const [chosen, setView] = useState<'heatmap' | 'monthly' | 'windows' | 'scenarios'>('heatmap');
  const view = only ?? chosen;

  // Low / best / high obstacle scenarios for the current day (real recomputation, not scaling).
  const scenarios = useMemo(() => {
    if (!sim || view !== 'scenarios') return null;
    const ctx = { lat: scene.origin.lat, lon: scene.origin.lon, tz: scene.timezone };
    return (['low', 'best', 'high'] as const).map((sc) => {
      const g = buildGeometry({ scene, recon: sim.recon, settings: { ...store.settings, scenario: sc }, trees: store.trees, extraBuildings: store.extraBuildings, selectedWindowIds: store.selectedWindowIds, apartment: store.apartment, detections: store.detections, camera: store.camera! });
      const ws = g.windows.filter((w) => ids.includes(w.fw.id)).map((w) => w.spec);
      const d = dailyExposure(buildObstacleIndex(g.obstacles), ws, store.date, ctx, 10);
      return { sc, d };
    });
  }, [sim, view, ids.join('|'), store.date, store.settings, store.trees, store.extraBuildings]);

  return (
    <div className={clsx('sm:h-[300px]', only ? 'px-4 py-3' : 'border-t border-ink-700 px-3 py-2')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {only ? <span className="text-xs text-ink-300">Direct sun through the year · click or tap a cell to jump to that day and time</span> : <div className="max-w-full overflow-x-auto"><Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'heatmap', label: 'Annual heatmap' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'windows', label: 'Window comparison' },
            { value: 'scenarios', label: 'Uncertainty scenarios' },
          ]}
        /></div>}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-400">
          {annual.running && <span>Computing in Web Worker… {Math.round(annual.progress * 100)}%</span>}
          {annual.result && <span>{annual.result.resolution.note}</span>}
          {!only && <Snapshots daily={daily} />}
        </div>
      </div>
      <div className="overflow-hidden sm:h-[244px]">
        {view === 'heatmap' && <Heatmap a={annual.result} />}
        {view === 'monthly' && <Monthly a={annual.result} />}
        {view === 'windows' && <WindowTable daily={daily} a={annual.result} />}
        {view === 'scenarios' && <Scenarios s={scenarios} />}
      </div>
    </div>
  );
}

function Snapshots({ daily }: { daily: DailyExposureResult | null }) {
  const snaps = useStore((s) => s.snapshots);
  const sel = useStore((s) => s.selectedWindowIds);
  const date = useStore((s) => s.date);
  const set = useStore((s) => s.set);
  if (!daily) return null;
  const cur = daily.aggregate.directMinutes;
  return (
    <div className="flex items-center gap-1.5">
      {snaps.map((s, i) => (
        <button key={i} type="button" onClick={() => set({ selectedWindowIds: s.windowIds, date: s.date })} className="inline-flex h-6 items-center rounded-md bg-ink-800 px-2 text-ink-200 transition-colors hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11" title="Restore this selection">
          {s.label}: <span className="num">{fmtDur(s.directMinutes)}</span>
          <span className={clsx('num ml-1', cur - s.directMinutes >= 0 ? 'text-obs' : 'text-danger-text')}>{cur - s.directMinutes >= 0 ? '+' : ''}{fmtDur(Math.abs(cur - s.directMinutes)).replace(/^/, cur - s.directMinutes < 0 ? '−' : '')}</span>
        </button>
      ))}
      <Btn kind="solid" onClick={() => set({ snapshots: [...snaps.slice(-2), { label: String.fromCharCode(65 + snaps.length), directMinutes: cur, windowIds: sel, date }] })} title="Save the current selection & result to compare against later">
        Pin for comparison
      </Btn>
    </div>
  );
}

function Heatmap({ a }: { a: AnnualResult | null }) {
  const [hover, setHover] = useState<{ d: number; b: number } | null>(null);
  const set = useStore((s) => s.set);
  if (!a) return <div className="grid h-full place-items-center text-xs text-ink-400">Preparing annual simulation…</div>;
  const nb = a.matrix[0]?.length ?? 96;
  const binMin = a.resolution.binMinutes;
  const cell = (v: number) => (v < 0 ? 'var(--color-night)' : v === 0 ? 'var(--color-away)' : `color-mix(in oklab, var(--color-lit) ${Math.round(25 + v * 75)}%, var(--color-unlit))`);
  return (
    <div className="flex h-full flex-col gap-3 sm:flex-row">
      <div className="relative min-w-0 flex-1">
        <svg viewBox={`0 0 ${nb} ${a.days.length}`} preserveAspectRatio="none" className="h-[220px] w-full rounded-md" onMouseLeave={() => setHover(null)}>
          {a.matrix.map((row, d) =>
            row.map((v, b) => <rect key={d * nb + b} x={b} y={d} width={1.02} height={1.02} style={{ fill: cell(v) }} onMouseEnter={() => setHover({ d, b })} onClick={() => {
                // Tapping also pins the read-out on that cell (there is no hover on a touch screen).
                setHover({ d, b });
                set({ date: a.days[d], minutes: b * binMin + binMin / 2 });
              }} />),
          )}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] leading-3 text-ink-400">
          {['00', '03', '06', '09', '12', '15', '18', '21', '24'].map((h, i) => <span key={h} className={clsx('num', i % 2 === 1 && 'hidden sm:inline')}>{h}:00</span>)}
        </div>
        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-ink-900 px-2 py-1 text-[11px] text-paper shadow-float">
            <span className="num">{a.days[hover.d]} {fmtMin(hover.b * binMin)}</span> · {a.matrix[hover.d][hover.b] < 0 ? 'night' : `${Math.round(a.matrix[hover.d][hover.b] * 100)}% lit`}
          </div>
        )}
      </div>
      <div className="shrink-0 space-y-2 text-[11px] sm:w-44">
        <div className="flex flex-wrap gap-x-3 gap-y-1 sm:flex-col">
          {[
            [cell(1), 'Direct sun'],
            [cell(0.4), 'Partially lit'],
            [cell(0), 'Shaded / facing away'],
            [cell(-1), 'Night'],
          ].map(([c, l]) => (
            <span key={l} className="flex items-center gap-1.5 text-ink-300"><span className="h-2.5 w-2.5 rounded-sm ring-1 ring-inset ring-ink-700" style={{ background: c }} />{l}</span>
          ))}
        </div>
        <Stat label="Year average" value={fmtDur(a.dailyDirectMinutes.reduce((x, y) => x + y, 0) / a.dailyDirectMinutes.length)} sub="direct sun per day" accent />
        <Stat label="Share of daylight" value={`${Math.round(a.directFractionOfDaylight * 100)}%`} sub="with direct sun" />
        <p className="text-[11px] text-ink-400">Rows: every {a.resolution.dayStepDays} days from Jan 1 (top). Click a cell to jump there.</p>
      </div>
    </div>
  );
}

function Monthly({ a }: { a: AnnualResult | null }) {
  if (!a) return <div className="grid h-full place-items-center text-xs text-ink-400">Preparing annual simulation…</div>;
  const max = Math.max(60, ...a.monthlyAvgDirectMinutes.map((v) => v ?? 0));
  return (
    <div className="flex h-full flex-col gap-4 sm:flex-row">
      <div className="flex h-[220px] flex-1 items-end gap-1 sm:gap-1.5">
        {a.monthlyAvgDirectMinutes.map((v, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="num text-[10px] leading-3 text-ink-300 [writing-mode:vertical-rl] sm:[writing-mode:horizontal-tb]">{v == null ? '' : fmtDur(v)}</span>
            <div className="w-full rounded-t-xs bg-lit" style={{ height: `${((v ?? 0) / max) * 170}px` }} />
            <span className="text-[10px] leading-3 text-ink-400">{MONTHS[i]}</span>
          </div>
        ))}
      </div>
      <div className="shrink-0 sm:w-64">
        <SectionTitle>Key dates</SectionTitle>
        <table className="w-full text-[11px]">
          <tbody>
            {a.keyDates?.map((k) => (
              <tr key={k.name} className="border-b border-ink-700 last:border-b-0">
                <td className="py-1 text-ink-300">{k.name}</td>
                <td className="num py-1 text-right text-sun-400">{fmtDur(k.directMinutes)}</td>
                <td className="num py-1 text-right text-ink-400">{k.firstDirect != null ? `${fmtMin(k.firstDirect)}–${fmtMin(k.lastDirect)}` : 'no sun'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-ink-400">Monthly values average the sampled days in each month.</p>
      </div>
    </div>
  );
}

function WindowTable({ daily, a }: { daily: DailyExposureResult | null; a: AnnualResult | null }) {
  const sim = useSimContext();
  const set = useStore((s) => s.set);
  if (!daily || !sim) return null;
  const byId = new Map(sim.geo.windows.map((w) => [w.fw.id, w]));
  const rows = [...daily.windows].sort((x, y) => y.directMinutes - x.directMinutes);
  const max = Math.max(1, ...rows.map((r) => r.directMinutes));
  return (
    <div className="h-full max-h-[244px] overflow-auto">
      <table className="w-full min-w-[520px] text-[11px]">
        <thead className="sticky top-0 bg-ink-900 text-left text-ink-400">
          <tr>
            <th className="py-1 font-medium">Window</th>
            <th className="font-medium">Floor</th>
            <th className="font-medium">Today</th>
            <th className="w-1/3 font-medium" />
            <th className="font-medium">First–last</th>
            <th className="font-medium">Year avg/day</th>
            <th className="font-medium">Main blocker</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const w = byId.get(r.windowId);
            return (
              <tr key={r.windowId} className="cursor-pointer border-b border-ink-800 hover:bg-ink-800/60" onClick={() => set({ selectedWindowIds: [r.windowId] })} onMouseEnter={() => set({ hoveredWindowId: r.windowId })} onMouseLeave={() => set({ hoveredWindowId: null })}>
                <td className="num py-1 text-ink-300">{r.windowId.replace('win-', '').slice(0, 8)}</td>
                <td className="num">{w?.fw.floor ?? '—'}</td>
                <td className="num text-sun-400">{fmtDur(r.directMinutes)}</td>
                <td><div className="h-1.5 rounded-xs bg-lit" style={{ width: `${(r.directMinutes / max) * 100}%` }} /></td>
                <td className="num text-ink-300">{r.firstDirect != null ? `${fmtMin(r.firstDirect)}–${fmtMin(r.lastDirect)}` : '—'}</td>
                <td className="num text-ink-300">{a ? fmtDur(a.perWindowAvgDirectMinutes[r.windowId]) : '…'}</td>
                <td className="truncate text-ink-400">{r.blockers[0]?.label ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Scenarios({ s }: { s: { sc: 'low' | 'best' | 'high'; d: DailyExposureResult }[] | null }) {
  if (!s) return <div className="grid h-full place-items-center text-xs text-ink-400">Computing…</div>;
  const max = Math.max(1, ...s.map((x) => x.d.aggregate.directMinutes));
  return (
    <div className="flex h-full flex-col gap-3 sm:flex-row sm:gap-6">
      <div className="flex-1 space-y-3 pt-2">
        {s.map(({ sc, d }) => (
          <div key={sc}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-ink-300">{sc === 'low' ? 'Low obstacles (lower-bound heights, trees −25%)' : sc === 'high' ? 'High obstacles (upper-bound heights, trees +25%)' : 'Best estimate'}</span>
              <span className="num text-sun-400">{fmtDur(d.aggregate.directMinutes)}</span>
            </div>
            <div className="h-1.5 rounded-xs bg-ink-800"><div className="h-1.5 rounded-xs bg-lit" style={{ width: `${(d.aggregate.directMinutes / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
      <p className="shrink-0 pt-2 text-[11px] leading-relaxed text-ink-400 sm:w-72">
        Each scenario rebuilds the obstacle geometry and reruns the ray-cast simulation for this date (10-min sampling). The spread shows how much the result depends on reconstruction uncertainty: a narrow spread means the answer is robust to the height estimates.
      </p>
    </div>
  );
}
