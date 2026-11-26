/**
 * Inline notice for the top bar: a compact status chip, or a docked strip on phones. Renders `store.notice` with at most one
 * action, routed by `notice.action`.
 *
 * The 'retry' action calls the callback registered by whoever raised the notice (the upload
 * flow), via `setNoticeRetry`. With no callback registered, the button is not shown, so
 * "Try again" never does nothing.
 */
import { useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { useStore } from '../state/store';

type Action = 'roboflow-key' | 'mark-windows' | 'add-view' | 'retry';

let retryFn: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Register (or clear with null) the callback behind the notice's "Try again" button. */
export function setNoticeRetry(fn: (() => void) | null): void {
  retryFn = fn;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const LABEL: Record<Action, string> = {
  'roboflow-key': 'Add my key',
  'mark-windows': 'Mark windows',
  'add-view': 'Add a photo',
  retry: 'Try again',
};

/**
 * `layout="inline"` (default): a one-line 28px chip for the top bar, text truncated (full text in the
 * tooltip). `layout="row"`: a full-width strip under the top bar on phones (hairline below), where
 * the text wraps and the buttons are 44px.
 */
/** 14px stroke icon: info circle, warning triangle, or error circle. */
function NoticeIcon({ kind, className }: { kind: 'info' | 'warning' | 'error'; className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      {kind === 'warning' ? (
        <>
          <path d="M8 2.5l6 10.5H2L8 2.5z" />
          <path d="M8 7v2.5M8 11.25v.01" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="5.75" />
          {kind === 'info' ? <path d="M8 7.25v3.5M8 5.25v.01" /> : <path d="M8 5v3.5M8 10.75v.01" />}
        </>
      )}
    </svg>
  );
}

export default function NoticeBar({ className, layout = 'inline' }: { className?: string; layout?: 'inline' | 'row' }) {
  const notice = useStore((s) => s.notice);
  const set = useStore((s) => s.set);
  const retry = useSyncExternalStore(subscribe, () => retryFn, () => null);
  if (!notice) return null;

  const run = (a: Action) => {
    if (a === 'roboflow-key') set({ keyDialogOpen: true });
    else if (a === 'mark-windows') set({ photoTool: 'add-window', leftTab: 'photo' });
    else if (a === 'add-view') set({ addViewOpen: true, leftTab: 'photo' });
    else if (a === 'retry' && retry) {
      set({ notice: null });
      retry();
    }
  };
  const action = notice.action && (notice.action !== 'retry' || retry) ? notice.action : null;
  const row = layout === 'row';

  const kind = notice.kind;
  const pill = (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={clsx(
        'fade-in flex min-w-0 max-w-full gap-2 text-xs',
        // Docked strip under the phone top bar vs. a compact 28px status chip inside the top bar.
        row ? 'items-start py-1 pl-3 pr-1 leading-5' : 'h-7 items-center rounded-md pl-2 pr-0.5 leading-4',
        kind === 'info' && (row ? 'bg-ink-900 text-ink-200' : 'bg-ink-800 text-ink-200'),
        kind === 'warning' && 'bg-sun-600/15 text-sun-300',
        kind === 'error' && 'bg-danger/15 text-danger-text',
        !row && className,
      )}
    >
      <NoticeIcon kind={kind} className={clsx('shrink-0', row && 'mt-[15px]', kind === 'info' ? 'text-ink-400' : kind === 'warning' ? 'text-sun-500' : 'text-danger')} />
      <span className={clsx('min-w-0 flex-1', row ? 'py-3' : 'truncate')} title={row ? undefined : notice.text}>
        {notice.text}
      </span>
      {action && (
        <button
          type="button"
          onClick={() => run(action)}
          className={clsx(
            'shrink-0 rounded-md px-2 text-xs font-semibold text-paper transition-colors hover:bg-paper/10 focus-visible:outline-2 focus-visible:outline-accent',
            row ? 'min-h-11' : 'h-6 pointer-coarse:min-h-11',
          )}
        >
          {LABEL[action]}
        </button>
      )}
      <button
        type="button"
        onClick={() => set({ notice: null })}
        aria-label="Dismiss"
        className={clsx(
          'grid shrink-0 place-items-center rounded-md text-current opacity-70 transition-colors hover:bg-paper/10 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent',
          row ? 'h-11 w-11' : 'h-6 w-6 pointer-coarse:h-11 pointer-coarse:w-11',
        )}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
  return row ? <div className={clsx('shrink-0 border-b border-ink-700 bg-ink-900', className)}>{pill}</div> : pill;
}
