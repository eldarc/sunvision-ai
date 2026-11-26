/**
 * Workspace top bar, 44px. Wordmark · title/city · NoticeBar · KeyPill · New photo ·
 * theme · Advanced. The height-mode control and the target height live in the What-if and
 * Building tabs, not here. Advanced mode adds the coordinates after the city.
 *
 * It collapses gracefully: below 1024px the theme toggle moves into a "More" menu; below 640px
 * (phones) only the wordmark, a key icon and the menu stay in the bar, and the notice moves to a
 * full-width row under it, where its text can wrap.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { Btn, Wordmark } from './ui';
import { ModeSwitch, ThemeToggle } from './kit';
import NoticeBar from './NoticeBar';
import KeyPill from './roboflow/KeyPill';
import { hasRoboflowKey, subscribeRoboflowKey } from '../lib/roboflowKey';

const iconBtn = 'grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-200 transition-colors hover:bg-ink-800 hover:text-paper pointer-coarse:h-11 pointer-coarse:w-11 focus-visible:outline-2 focus-visible:outline-accent';
/** A row in the "More" menu: 28px, left-aligned, grey hover (44px under a finger). */
const menuRow = 'flex min-h-7 w-full items-center rounded-md px-2 text-left text-xs hover:bg-accent-500 hover:text-on-accent focus-visible:bg-accent-500 focus-visible:text-on-accent focus-visible:outline-none pointer-coarse:min-h-11';

/** Phone stand-in for KeyPill: an icon with a status dot. Hidden like KeyPill when nothing is known. */
function KeyIcon() {
  const hasKey = useSyncExternalStore(subscribeRoboflowKey, hasRoboflowKey, () => false);
  const quota = useStore((s) => s.sharedQuota);
  const set = useStore((s) => s.set);
  if (!hasKey && !quota) return null;
  const exhausted = !hasKey && !!quota?.exhausted;
  const label = hasKey ? 'Roboflow key: using your key' : exhausted ? 'Roboflow key: free limit reached, add your key' : quota?.enabled ? 'Roboflow key: using the shared key' : 'Add a Roboflow key';
  return (
    <button type="button" className={clsx(iconBtn, 'relative')} onClick={() => set({ keyDialogOpen: true })} aria-haspopup="dialog" aria-label={label} title={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="5.25" cy="10.75" r="2.75" />
        <path d="M7.25 8.75l6-6M11.25 4.75l1.5 1.5M9.75 6.25l1 1" />
      </svg>
      {(hasKey || exhausted) && (
        <span aria-hidden className={clsx('absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-ink-900 pointer-coarse:right-2.5 pointer-coarse:top-2.5', hasKey ? 'bg-obs' : 'bg-sun-600')} />
      )}
    </button>
  );
}

function MoreMenu({ place }: { place: string }) {
  const [open, setOpen] = useState(false);
  const scene = useStore((s) => s.scene);
  const set = useStore((s) => s.set);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus();
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

  const go = (p: Parameters<typeof set>[0]) => {
    setOpen(false);
    set(p);
  };

  return (
    <div
      className="relative lg:hidden"
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button ref={btn} type="button" className={iconBtn} aria-expanded={open} aria-controls={id} aria-label="More: theme, mode and photo" title="More" onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="region"
          aria-label="More options"
          className="pop-in absolute right-0 top-[calc(100%+4px)] z-50 w-[min(15rem,calc(100vw-1rem))] rounded-lg bg-ink-900 p-1 text-paper shadow-panel"
        >
          {scene && (
            <>
              <div className="min-w-0 px-2 py-1.5 md:hidden">
                <div className="truncate text-xs font-medium leading-4 text-paper">{scene.title}</div>
                {place && <div className="truncate text-[11px] leading-4 text-ink-400">{place}</div>}
              </div>
              <div aria-hidden className="-mx-1 my-1 h-px bg-ink-700 md:hidden" />
            </>
          )}
          <div className="flex h-6 items-center px-2 text-[11px] font-medium text-ink-400">Theme</div>
          <div className="px-1 pb-1">
            <ThemeToggle labels className="flex w-full [&>button]:flex-1" />
          </div>
          <div className="sm:hidden">
            <div aria-hidden className="-mx-1 my-1 h-px bg-ink-700" />
            <div className="flex min-h-7 items-center justify-between gap-2 pl-2">
              <span className="text-xs text-ink-300">Every setting</span>
              <ModeSwitch />
            </div>
            <div aria-hidden className="-mx-1 my-1 h-px bg-ink-700" />
            <button type="button" className={clsx(menuRow, 'text-paper')} onClick={() => go({ route: { name: 'upload' } })}>
              New photo
            </button>
            <button type="button" className={clsx(menuRow, 'text-ink-200')} onClick={() => go({ route: { name: 'landing' } })}>
              Back to the start page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopBar() {
  const scene = useStore((s) => s.scene);
  const uiMode = useStore((s) => s.uiMode);
  const set = useStore((s) => s.set);
  if (!scene) return null;
  const place = [scene.city, scene.country].filter(Boolean).join(', ');
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 pl-2 pr-1 sm:gap-3 sm:pr-2">
        <button
          type="button"
          className="flex min-h-7 shrink-0 items-center rounded-md px-1.5 transition-colors hover:bg-ink-800 pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => set({ route: { name: 'landing' } })}
          aria-label="sunvisionai, back to the start page"
          title="Back to the start page"
        >
          <Wordmark size="sm" />
        </button>
        <div aria-hidden className="-ml-1 hidden h-4 w-px shrink-0 bg-ink-700 md:block" />
        <div className="hidden min-w-0 max-w-[30rem] shrink items-baseline gap-2 md:flex">
          <span className="min-w-0 shrink truncate text-[13px] font-medium leading-5 text-paper" title={scene.title}>
            {scene.title}
          </span>
          <span className="min-w-0 shrink-[2] truncate text-xs leading-5 text-ink-400" title={place || undefined}>
            {place}
            {uiMode === 'advanced' && (
              <>
                {' · '}
                <span className="num">
                  {scene.origin.lat.toFixed(5)}, {scene.origin.lon.toFixed(5)}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="hidden min-w-0 flex-1 justify-center sm:flex">
          <NoticeBar />
        </div>
        <div className="flex-1 sm:hidden" />
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden sm:inline-flex">
            <KeyPill />
          </span>
          <span className="sm:hidden">
            <KeyIcon />
          </span>
          <span className="hidden sm:inline-flex">
            <Btn kind="solid" onClick={() => set({ route: { name: 'upload' } })}>
              <span className="btn-label">New photo</span>
            </Btn>
          </span>
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-ink-700 lg:block" />
          <span className="hidden lg:inline-flex">
            <ThemeToggle />
          </span>
          <span className="hidden sm:inline-flex">
            <ModeSwitch />
          </span>
          <MoreMenu place={place} />
        </div>
      </header>
      <NoticeBar layout="row" className="sm:hidden" />
    </>
  );
}
