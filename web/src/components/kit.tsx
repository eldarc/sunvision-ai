/**
 * Shared UI primitives for the workspace, imported across the app. Keep them dependency-light
 * (no three.js, no maplibre).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { useResolvedTheme } from '../lib/theme';
import type { Provenance } from '../schema/scene';
import { provMeta } from './ui';

type InspectorTab = 'building' | 'camera' | 'apartment' | 'whatif' | 'sources';

/** Visible label of each Inspector tab button (the Inspector has no tab API, so its buttons are found by text). */
const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = {
  building: 'Building',
  camera: 'Camera',
  apartment: 'Apartment',
  whatif: 'What-if',
  sources: 'Provenance',
};

/** Children only in Advanced mode; `fallback` (or nothing) in simple mode. */
export function Advanced({ children, fallback }: { children: ReactNode; fallback?: ReactNode }): ReactElement | null {
  const mode = useStore((s) => s.uiMode);
  if (mode === 'advanced') return <>{children}</>;
  return fallback != null ? <>{fallback}</> : null;
}

/** Local disclosure: "Fine-tune ▸" / "Fine-tune ▾". */
export function FineTune({ label = 'Fine-tune', children, defaultOpen = false }: { label?: string; children: ReactNode; defaultOpen?: boolean }): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 inline-flex min-h-7 pointer-coarse:min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium text-ink-300 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className={clsx('transition-transform motion-reduce:transition-none', open && 'rotate-90')}>
          <path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>
      {open && (
        <div id={id} className="fade-in pt-1">
          {children}
        </div>
      )}
    </div>
  );
}

/** Try to switch the Inspector to a tab once it has mounted. Best effort. */
function focusInspectorTab(tab: InspectorTab, tries = 12) {
  if (typeof document === 'undefined') return;
  const label = INSPECTOR_TAB_LABEL[tab];
  const attempt = (n: number) => {
    const root = document.querySelector('[data-inspector]');
    const btn = root ? Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) : undefined;
    if (btn) {
      btn.click();
      btn.scrollIntoView({ block: 'nearest' });
      btn.focus();
    } else if (n > 0) requestAnimationFrame(() => attempt(n - 1));
  };
  requestAnimationFrame(() => attempt(tries));
}

/** Link that switches to Advanced mode and (best effort) opens an Inspector tab. */
export function GoAdvanced({ label, tab }: { label: string; tab?: InspectorTab }): ReactElement {
  const setUiMode = useStore((s) => s.setUiMode);
  return (
    <button
      type="button"
      onClick={() => {
        setUiMode('advanced');
        if (tab) focusInspectorTab(tab);
      }}
      className="inline-flex min-h-7 pointer-coarse:min-h-11 items-center gap-1 rounded-sm text-xs font-medium text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {label} <span aria-hidden>→</span>
    </button>
  );
}

const stepBtn =
  'grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-sm text-ink-200 transition-colors hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:h-11 pointer-coarse:min-w-11';

/** − value + as one input-like field: 28 px buttons inside a grey well. */
export function Stepper({ label, value, onDec, onInc, decLabel, incLabel, decDisabled, incDisabled }: { label?: string; value: ReactNode; onDec: () => void; onInc: () => void; decLabel: string; incLabel: string; decDisabled?: boolean; incDisabled?: boolean }): ReactElement {
  const id = useId();
  return (
    <div className="flex items-center gap-2" role="group" aria-labelledby={label ? id : undefined}>
      {label && (
        <span id={id} className="min-w-0 flex-1 text-xs text-ink-300">
          {label}
        </span>
      )}
      <span className="inline-flex items-center rounded-md bg-ink-800">
        <button type="button" className={stepBtn} onClick={onDec} disabled={decDisabled} aria-label={decLabel} title={decLabel}>
          <span aria-hidden>−</span>
        </button>
        <span className="num min-w-[5.5rem] text-center text-xs font-medium text-paper" aria-live="polite">
          {value}
        </span>
        <button type="button" className={stepBtn} onClick={onInc} disabled={incDisabled} aria-label={incLabel} title={incLabel}>
          <span aria-hidden>+</span>
        </button>
      </span>
    </div>
  );
}

/** Switch labelled "Advanced", bound to `uiMode` (persisted by the store). */
export function ModeSwitch(): ReactElement {
  const mode = useStore((s) => s.uiMode);
  const setUiMode = useStore((s) => s.setUiMode);
  const on = mode === 'advanced';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setUiMode(on ? 'simple' : 'advanced')}
      title={on ? 'Back to the simple view' : 'Show every setting and the full analytics'}
      className="inline-flex min-h-7 pointer-coarse:min-h-11 select-none items-center gap-2 rounded-md px-2 text-xs font-medium text-ink-200 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span aria-hidden className={clsx('relative inline-block h-3.5 w-6 rounded-full transition-colors', on ? 'bg-accent' : 'bg-ink-600')}>
        <span className={clsx('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-knob shadow-float transition-all motion-reduce:transition-none', on ? 'left-3' : 'left-0.5')} />
      </span>
      Advanced
    </button>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Open dialogs, bottom first. Only the top-most one handles Tab and Esc, so stacked dialogs (a
 * dialog that opens another, e.g. the key dialog over "Add a photo") keep one focus trap.
 */
const dialogStack: { el: HTMLElement | null }[] = [];

/** Focus trap + Esc + return focus to the opener while `open`. */
function useDialogBehaviour(open: boolean, onClose: () => void, panel: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const token = { el };
    dialogStack.push(token);
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const a = items[0];
      const b = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || !el.contains(document.activeElement))) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && (document.activeElement === b || !el.contains(document.activeElement))) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = dialogStack.indexOf(token);
      const wasTop = i === dialogStack.length - 1;
      if (i >= 0) dialogStack.splice(i, 1);
      if (!wasTop) return;
      // Back to the opener; else into the dialog underneath, if any.
      const below = dialogStack[dialogStack.length - 1]?.el;
      if (opener && document.contains(opener) && (!below || below.contains(opener))) opener.focus();
      else if (below && document.contains(below)) (below.querySelector<HTMLElement>(FOCUSABLE) ?? below).focus();
      else if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, panel]);
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-300 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11">
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
        <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** Centred dialog with a focus trap. Esc closes it and focus returns to the opener. */
export function Modal({ open, onClose, title, width = 520, children }: { open: boolean; onClose: () => void; title: string; width?: number; children: ReactNode }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehaviour(open, onClose, ref);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim p-3 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pop-in w-full rounded-xl bg-ink-900 text-paper shadow-panel outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex h-11 items-center justify-between gap-3 border-b border-ink-700 pl-4 pr-2">
          <h2 id={titleId} className="text-[13px] font-semibold leading-5">
            {title}
          </h2>
          <CloseX onClose={onClose} />
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Right-side drawer, 380px (full width on phones). */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehaviour(open, onClose, ref);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="sheet-in flex h-full w-full max-w-[380px] flex-col border-l border-ink-700 bg-ink-900 text-paper shadow-panel outline-none">
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ink-700 pl-4 pr-2">
          <h2 id={titleId} className="text-[13px] font-semibold leading-5">
            {title}
          </h2>
          <CloseX onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 6px provenance dot; the tooltip carries the description, screen readers get the label. */
export function Dot({ p }: { p: Provenance }): ReactElement {
  const m = provMeta[p];
  return (
    <span className="relative inline-flex shrink-0 items-center align-middle" title={`${m.label}: ${m.desc}`}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      <span className="sr-only">{`(${m.label.toLowerCase()})`}</span>
    </span>
  );
}

/** Small pill toggle button. */
export function Chip({ selected, onClick, children }: { selected?: boolean; onClick?: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={clsx(
        'inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:px-3.5',
        selected ? 'bg-selected text-paper ring-1 ring-inset ring-accent' : 'text-ink-200 ring-1 ring-inset ring-ink-700 hover:bg-ink-800 hover:text-paper',
      )}
    >
      <span className="btn-label">{children}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Theme toggle                                                                */
/* -------------------------------------------------------------------------- */

type ThemePref = 'system' | 'light' | 'dark';

const iconProps = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const THEME_ICON: Record<ThemePref, ReactElement> = {
  system: (
    <svg {...iconProps}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </svg>
  ),
  light: (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </svg>
  ),
  dark: (
    <svg {...iconProps}>
      <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />
    </svg>
  ),
};
const THEME_NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];

/**
 * Three-way colour theme control: System (follows the device) / Light / Dark. A radio group
 * with a roving tab stop (arrow keys move and select), icons, aria labels and tooltips.
 * Bound to `themePreference` (persisted to localStorage 'sv.theme' by the store).
 *
 * `size="sm"`: 32px buttons (44px under a coarse pointer); `size="md"`: 44px everywhere.
 * `labels`: show "System / Light / Dark" next to the icons (menus, settings sheets).
 */
export function ThemeToggle({ className, size = 'sm', labels = false }: { className?: string; size?: 'sm' | 'md'; labels?: boolean }): ReactElement {
  const pref = useStore((s) => s.themePreference);
  const setPref = useStore((s) => s.setThemePreference);
  const resolved = useResolvedTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const describe = (t: ThemePref) => (t === 'system' ? `System theme: follows your device (now ${resolved})` : `${THEME_NAME[t]} theme`);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + THEME_ORDER.length) % THEME_ORDER.length;
    setPref(THEME_ORDER[j]);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Colour theme" className={clsx('inline-flex shrink-0 items-center rounded-md bg-ink-800 p-0.5', className)}>
      {THEME_ORDER.map((t, i) => {
        const on = pref === t;
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={describe(t)}
            title={describe(t)}
            tabIndex={on ? 0 : -1}
            onClick={() => setPref(t)}
            onKeyDown={(e) => onKey(e, i)}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 rounded-sm text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              size === 'md' ? 'h-9 min-w-9 pointer-coarse:h-11 pointer-coarse:min-w-11' : 'h-6 min-w-6 pointer-coarse:h-11 pointer-coarse:min-w-11',
              labels ? 'px-3' : 'px-0',
              on ? 'bg-ink-900 text-paper shadow-float' : 'text-ink-400 hover:text-paper',
            )}
          >
            {THEME_ICON[t]}
            {labels && <span className="btn-label">{THEME_NAME[t]}</span>}
          </button>
        );
      })}
    </div>
  );
}
