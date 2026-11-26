import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { Provenance } from '../schema/scene';

export const provMeta: Record<Provenance, { label: string; color: string; desc: string }> = {
  observed: { label: 'Observed', color: 'var(--color-obs)', desc: 'Measured directly from the photograph or its metadata' },
  inferred: { label: 'Inferred', color: 'var(--color-inf)', desc: 'Computed from observations and geometry' },
  map: { label: 'Map', color: 'var(--color-map)', desc: 'From OpenStreetMap or another geographic dataset' },
  assumed: { label: 'Assumed', color: 'var(--color-asm)', desc: 'A default assumption — please verify' },
  manual: { label: 'Manual', color: 'var(--color-man)', desc: 'Corrected by you' },
};

export function Prov({ p, className }: { p: Provenance; className?: string }) {
  const m = provMeta[p];
  return (
    <span title={m.desc} className={clsx('inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium leading-none', className)} style={{ color: m.color, background: `color-mix(in oklab, ${m.color} 14%, transparent)` }}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold leading-4 text-paper">{children}</h3>
      {right}
    </div>
  );
}

/**
 * Buttons: 28 px tall, 12 px medium text, 5 px corners.
 * ghost: no fill until hover. solid: secondary, hairline outline. sun / primary: the blue primary
 * action (`sun` is an alias of `primary`; the sun colour is reserved for data).
 */
export function Btn({ children, onClick, active, className, title, disabled, kind = 'ghost', ariaLabel }: { children: ReactNode; onClick?: () => void; active?: boolean; className?: string; title?: string; disabled?: boolean; kind?: 'ghost' | 'solid' | 'sun' | 'primary'; ariaLabel?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        // 44 px on touch screens (WCAG 2.5.5), whatever height the caller sets.
        'inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium leading-4 whitespace-nowrap transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
        kind === 'ghost' && (active ? 'bg-selected text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper'),
        kind === 'solid' && (active ? 'bg-selected text-paper ring-1 ring-inset ring-accent' : 'text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800'),
        (kind === 'sun' || kind === 'primary') && 'bg-accent-500 text-on-accent hover:bg-accent-600',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'sm' }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'xs' }) {
  return (
    <div className="inline-flex rounded-md bg-ink-800 p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx('rounded-sm px-2 font-medium transition-colors pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-accent', size === 'sm' ? 'h-6 text-xs' : 'h-5 text-[11px]', value === o.value ? 'bg-ink-900 text-paper shadow-float' : 'text-ink-300 hover:text-paper')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, color }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; color?: string }) {
  return (
    <label className="flex min-h-8 cursor-pointer select-none items-center gap-2 text-xs text-ink-200 hover:text-paper">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={clsx('relative inline-block h-3.5 w-6 shrink-0 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent', checked ? 'bg-accent' : 'bg-ink-600')}
        style={checked && color ? { background: color } : undefined}
      >
        <span className={clsx('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-knob shadow-float transition-all motion-reduce:transition-none', checked ? 'left-3' : 'left-0.5')} />
      </span>
      {label}
    </label>
  );
}

export function Slider({ label, value, min, max, step, onChange, unit, prov, format, onReset }: { label: ReactNode; value: number; min: number; max: number; step: number; onChange: (v: number) => void; unit?: string; prov?: Provenance; format?: (v: number) => string; onReset?: () => void }) {
  return (
    <div className="py-1">
      <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-ink-400">
          {label}
          {prov && <Prov p={prov} />}
        </span>
        <span className="flex items-center gap-1.5">
          {onReset && (
            <button type="button" className="text-[11px] text-accent-300 hover:underline" onClick={onReset} title="Revert to estimate">
              Reset
            </button>
          )}
          <span className="num text-paper">
            {format ? format(value) : value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}
            {unit && <span className="text-ink-400">{unit}</span>}
          </span>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={typeof label === 'string' ? label : undefined} />
    </div>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] leading-4 text-ink-400">{label}</div>
      <div className={clsx('num truncate text-[15px] font-medium leading-5 tracking-[-0.01em]', accent ? 'text-sun-400' : 'text-paper')}>{value}</div>
      {sub && <div className="truncate text-[11px] text-ink-400">{sub}</div>}
    </div>
  );
}

export const fmtMin = (m: number | null | undefined) => {
  if (m == null || !isFinite(m)) return '—';
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};
export const fmtDur = (m: number | null | undefined) => {
  if (m == null || !isFinite(m)) return '—';
  // Round the total first, so 119.5 min reads "2h 00m", never "1h 60m".
  const t = Math.round(m);
  const h = Math.floor(t / 60);
  const mm = t % 60;
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={clsx('shrink-0', className)} aria-hidden="true" focusable="false">
      {/* A window with the sun in its corner. Edges sit on the 8-unit grid, so the frame is exactly 2 px at 16 px. */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M14 8H50A6 6 0 0 1 56 14V50A6 6 0 0 1 50 56H14A6 6 0 0 1 8 50V14A6 6 0 0 1 14 8ZM18 16A2 2 0 0 0 16 18V46A2 2 0 0 0 18 48H46A2 2 0 0 0 48 46V18A2 2 0 0 0 46 16Z"
      />
      <path style={{ fill: 'var(--color-lit)' }} d="M46 16A2 2 0 0 1 48 18V36A20 20 0 0 1 28 16Z" />
    </svg>
  );
}

/** The product name, as written everywhere user-facing. */
export const BRAND = 'sunvisionai';

const WORDMARK_SIZE = {
  sm: { logo: 'h-[18px] w-[18px]', text: 'text-[13px]', gap: 'gap-1.5' },
  md: { logo: 'h-5 w-5', text: 'text-sm', gap: 'gap-1.5' },
  lg: { logo: 'h-7 w-7', text: 'text-xl', gap: 'gap-2' },
} as const;

/**
 * Logo + "sunvisionai" (Inter 600, tight), with "ai" set in the secondary text colour. The text is real
 * text, so it is the accessible name when the wordmark sits in a link or button.
 * `text={false}` keeps the logo only (the name is then visually hidden, still read out).
 */
export function Wordmark({ size = 'md', text = true, className }: { size?: keyof typeof WORDMARK_SIZE; text?: boolean; className?: string }) {
  const z = WORDMARK_SIZE[size];
  return (
    <span className={clsx('inline-flex shrink-0 items-center text-paper', z.gap, className)}>
      <Logo className={z.logo} />
      <span className={clsx('font-semibold leading-none tracking-[-0.02em]', z.text, !text && 'sr-only')}>
        sunvision<span className="font-medium text-ink-400">ai</span>
      </span>
    </span>
  );
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "15 April" from a YYYY-MM-DD scene-local date (no Date object, so no timezone shift). */
export const fmtDayMonth = (iso: string, short = false) => {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!m || !d) return iso;
  const name = MONTH_NAMES[m - 1];
  return `${d} ${short ? name.slice(0, 3) : name}`;
};
export const monthName = (i: number, short = false) => (short ? MONTH_NAMES[i].slice(0, 3) : MONTH_NAMES[i]);

/** Signed duration for deltas: "+48m", "−1h 05m", "±0m". */
export const fmtDelta = (m: number) => {
  const r = Math.round(m);
  if (r === 0) return '±0m';
  return `${r > 0 ? '+' : '−'}${fmtDur(Math.abs(r))}`;
};

/** Azimuth (deg clockwise from north) of a horizontal ENU normal. Same formula as Inspector's facadeAzimuth. */
export const azimuthOf = (n: readonly number[]) => ((Math.atan2(n[0], n[1]) * 180) / Math.PI + 360) % 360;

const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 16-point compass name, e.g. "SSW". */
export const compass16 = (deg: number) => COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** "Ground floor" for 0, otherwise "Floor n". */
export const floorLabel = (n: number) => (n === 0 ? 'Ground floor' : `Floor ${n}`);

/** Plain-language provenance of a building height. */
export const heightSourceWords: Record<Provenance, string> = {
  observed: 'height measured in photo',
  inferred: 'height estimated from photo',
  map: 'height from map data',
  assumed: 'height assumed',
  manual: 'height set by you',
};
