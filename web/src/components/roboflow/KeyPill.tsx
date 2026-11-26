/**
 * KeyPill: top bar and landing nav, a quiet 28px status control (dot or key icon + label). Shows which Roboflow allowance analyses will use and
 * opens the key dialog. A number appears only when /api/health reports `sharedQuota.remaining` (our own
 * counter, never invented). The key itself is never read into React state; only "is a key saved".
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { useStore } from '../../state/store';
import { fetchHealth } from '../../lib/analyzeApi';
import { hasRoboflowKey, subscribeRoboflowKey } from '../../lib/roboflowKey';

type PillState = 'own' | 'exhausted' | 'count' | 'shared' | 'add' | 'unknown';

function useHasRoboflowKey(): boolean {
  return useSyncExternalStore(subscribeRoboflowKey, hasRoboflowKey, () => false);
}

export default function KeyPill() {
  const hasKey = useHasRoboflowKey();
  const quota = useStore((s) => s.sharedQuota);
  const onLanding = useStore((s) => s.route.name === 'landing');
  const set = useStore((s) => s.set);
  const dot = useRef<HTMLSpanElement>(null);

  // Ask the server once per mount when nothing is known yet (no polling).
  useEffect(() => {
    if (useStore.getState().sharedQuota == null) void fetchHealth();
  }, []);

  const state: PillState = hasKey
    ? 'own'
    : !quota
      ? 'unknown'
      : quota.exhausted
        ? 'exhausted'
        : quota.enabled && quota.remaining != null
          ? 'count'
          : quota.enabled
            ? 'shared'
            : 'add';

  // "Free limit reached" pulses once (≤300ms), unless the user prefers reduced motion.
  useEffect(() => {
    if (state !== 'exhausted' || !dot.current) return;
    try {
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      dot.current.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(2.2)' }, { transform: 'scale(1)' }], { duration: 300, iterations: 1, easing: 'ease-out' });
    } catch {
      /* animation unsupported */
    }
  }, [state]);

  // No backend (or not known yet): hidden in the workspace; on the landing the dialog stays findable.
  if (state === 'unknown' && !onLanding) return null;

  let label: string;
  let title: string;
  let dotColor: string | null = null;
  switch (state) {
    case 'own':
      label = 'Your Roboflow key';
      title = 'Using your Roboflow key. Click to change or remove it.';
      dotColor = 'var(--color-obs)';
      break;
    case 'exhausted':
      label = 'Free limit reached · add key';
      title = "This server's shared Roboflow allowance is used up. Add your own free key.";
      dotColor = 'var(--color-sun-600)';
      break;
    case 'count': {
      const n = quota!.remaining!;
      label = `Free analyses left: ${n.toLocaleString('en-US')}`;
      title = 'Counted by this sunvisionai server for its shared key this month.';
      break;
    }
    case 'shared':
      label = 'Shared Roboflow key';
      title = 'Analyses use this server’s shared Roboflow key. Add your own free key to avoid its limit.';
      break;
    case 'add':
      label = 'Add Roboflow key';
      title = 'This server has no shared Roboflow key. Add your own free key to analyse photos.';
      break;
    default:
      label = 'Roboflow key';
      title = 'Use your own free Roboflow key for photo analysis.';
  }

  return (
    <button
      type="button"
      onClick={() => set({ keyDialogOpen: true })}
      aria-haspopup="dialog"
      title={title}
      aria-label={`${label}. ${title}`}
      className={clsx(
        "relative inline-flex h-7 shrink-0 items-center after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] sm:after:hidden gap-1.5 whitespace-nowrap rounded-md pl-1.5 pr-2 text-xs font-medium leading-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        state === 'exhausted' ? 'bg-sun-600/15 text-sun-300 hover:bg-sun-600/25' : 'text-ink-200 hover:bg-ink-800 hover:text-paper',
      )}
    >
      <span aria-hidden className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        {dotColor ? (
          <span ref={dot} className="h-1.5 w-1.5 rounded-full" style={{ background: dotColor }} />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-400">
            <circle cx="5.25" cy="10.75" r="2.75" />
            <path d="M7.25 8.75l6-6M11.25 4.75l1.5 1.5M9.75 6.25l1 1" />
          </svg>
        )}
      </span>
      {state === 'count' ? (
        <span>
          Free analyses left: <span className="num">{quota!.remaining!.toLocaleString('en-US')}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}
