/**
 * RoboflowKeyDialog (byok.md §4–5): paste, check, save or remove the user's own Roboflow key.
 * Mounted once by the app shell; opens whenever `store.keyDialogOpen` is true.
 *
 * "Required" variant: while lib/roboflowKey.ts holds a key prompt (automatic detection is blocked for want of
 * a working key, see lib/analyzeApi.ts `detectionCheck` / `askForKey`), the dialog leads with
 * "Add your free Roboflow key to detect windows automatically", says why in one sentence, says that
 * detection restarts by itself once the key is saved (when the caller armed a retry), and offers
 * "Mark windows by hand instead".
 *
 * The typed key lives only in this component's local state while the dialog is open, then in
 * session/localStorage via lib/roboflowKey.ts. It never enters the zustand store, URLs or logs.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import clsx from 'clsx';
import { Modal } from '../kit';
import { useStore } from '../../state/store';
import {
  clearRoboflowKey,
  getRoboflowKey,
  hasRoboflowKey,
  isPlausibleKeyFormat,
  isRoboflowKeyRemembered,
  looksPublishable,
  setRoboflowKey,
  subscribeRoboflowKey,
  validateRoboflowKey,
  getKeyPrompt,
  setKeyPrompt,
  subscribeKeyPrompt,
} from '../../lib/roboflowKey';

export const REQUIRED_TITLE = 'Add your free Roboflow key to detect windows automatically';

/** One sentence on why a key is needed now, per reason code. */
/**
 * Autofocus the key input only with a mouse/trackpad: on a phone the on-screen keyboard would
 * cover the "why" sentence and "Mark windows by hand instead" as soon as the dialog opens.
 */
const finePointer = () => typeof matchMedia !== 'function' || matchMedia('(pointer: fine)').matches;

export function requiredReason(code: string, until: string | null): string {
  switch (code) {
    case 'shared_quota_exhausted':
      return `This demo's shared Roboflow allowance is used up${until ? ` until ${until}` : ' for this month'}, so it can't find the windows in your photo. Your own free key makes automatic detection possible again.`;
    case 'shared_rate_limited':
      return "You've used today's free analyses on the shared key. Your own free key makes automatic detection possible again right away.";
    case 'shared_key_unavailable':
      return 'This server has no shared Roboflow key, so windows can only be detected automatically with your own free key.';
    case 'user_key_invalid':
      return "Roboflow rejected the saved key, so detection can't run. Paste your Private API Key again.";
    case 'user_key_format':
      return "The saved key doesn't look like a Roboflow API key, so detection can't run. Paste your Private API Key again.";
    case 'user_key_forbidden':
      return "Your key works but can't run the facade model. Use a key that can run public Universe models.";
    case 'user_key_no_credits':
      return 'Your Roboflow workspace is out of credits this month, so detection can\'t run. A key from a workspace with credits makes it possible again.';
    case 'user_billing_paused':
      return 'Billing for your Roboflow workspace is paused, so detection can\'t run. A key from another workspace makes it possible again.';
    default:
      return 'Automatic window detection needs a Roboflow key here. A free one makes it possible.';
  }
}

type Check = { s: 'idle' } | { s: 'checking' } | { s: 'ok'; ws: string | null } | { s: 'invalid' } | { s: 'publishable' } | { s: 'network' } | { s: 'format' };

/** The setup-step links are actions: 44 px tall on touch screens. */
const STEP_LINK = 'pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center';
const LINK = 'rounded-sm text-accent-300 underline decoration-accent-300/35 underline-offset-2 hover:decoration-accent-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
const BTN = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-medium transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40';
const DOT = 'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full';

function fmtReset(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  } catch {
    return null;
  }
}

function Ext({ href, children, className, icon = false }: { href: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={clsx(LINK, className)}>
      {children}
      {icon && <ExternalIcon />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="ml-1 inline-block align-[-0.5px]">
      <path d="M3.5 1.5h5v5M8.5 1.5l-7 7" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

export default function RoboflowKeyDialog() {
  const open = useStore((s) => s.keyDialogOpen);
  const set = useStore((s) => s.set);
  const quota = useStore((s) => s.sharedQuota);
  const hasKey = useSyncExternalStore(subscribeRoboflowKey, hasRoboflowKey, () => false);
  const prompt = useSyncExternalStore(subscribeKeyPrompt, getKeyPrompt, () => null);

  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(false);
  const [check, setCheck] = useState<Check>({ s: 'idle' });
  const [confirmUnchecked, setConfirmUnchecked] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [exhaustedOnOpen, setExhaustedOnOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const inputId = useId();
  const helpId = useId();
  const statusId = useId();

  // Reset on every open; nothing typed survives a close.
  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      abort.current = null;
      setValue('');
      return;
    }
    setValue('');
    setShow(false);
    setRemember(isRoboflowKeyRemembered());
    setCheck({ s: 'idle' });
    setConfirmUnchecked(false);
    setStatus(null);
    const q = useStore.getState().sharedQuota;
    setExhaustedOnOpen(!!q?.exhausted && !hasRoboflowKey());
  }, [open]);

  useEffect(() => () => abort.current?.abort(), []);

  const close = () => set({ keyDialogOpen: false });

  const typed = value.trim();
  const onInput = (v: string) => {
    setValue(v);
    setConfirmUnchecked(false);
    setStatus(null);
    abort.current?.abort();
    // Publishable keys are recognised as they are pasted, with no network call.
    setCheck(looksPublishable(v) ? { s: 'publishable' } : { s: 'idle' });
  };

  const runCheck = async () => {
    if (!typed || check.s === 'checking') return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setStatus(null);
    setConfirmUnchecked(false);
    setCheck({ s: 'checking' });
    try {
      const r = await validateRoboflowKey(typed, ac.signal);
      if (ac.signal.aborted) return;
      if (r.ok) setCheck({ s: 'ok', ws: r.workspace ?? null });
      else if (r.reason === 'publishable' || r.reason === 'network' || r.reason === 'format' || r.reason === 'invalid') setCheck({ s: r.reason });
      else setCheck({ s: 'idle' });
    } catch {
      /* aborted: a newer check or a close replaced this one */
    }
  };

  const blocked = check.s === 'checking' || check.s === 'invalid' || check.s === 'publishable' || check.s === 'format' || !typed;
  const verified = check.s === 'ok' || check.s === 'network';
  const saveLabel = !verified && confirmUnchecked ? 'Save without checking' : 'Save key';

  const save = () => {
    if (blocked) return;
    if (!isPlausibleKeyFormat(typed)) {
      setCheck({ s: 'format' });
      return;
    }
    if (!verified && !confirmUnchecked) {
      setConfirmUnchecked(true);
      return;
    }
    const retrying = !!prompt?.autoRetry;
    setRoboflowKey(typed, remember); // clears the prompt; an armed upload retries detection now
    setValue('');
    set({ keyDialogOpen: false, notice: { kind: 'info', text: retrying ? 'Saved. Finding windows with your key…' : 'Saved. New analyses use your key.' } });
  };

  const markByHand = () => {
    const p = getKeyPrompt();
    setKeyPrompt(null);
    set({ keyDialogOpen: false });
    if (p?.onManual) p.onManual();
    else set({ photoTool: 'add-window', notice: { kind: 'info', text: 'Mark the windows yourself: drag a box over each one.', action: 'mark-windows' } });
  };

  const removeKey = () => {
    clearRoboflowKey();
    setValue('');
    setCheck({ s: 'idle' });
    setConfirmUnchecked(false);
    setStatus('Key removed from this browser.');
    const n = useStore.getState().notice;
    if (n?.text === 'Saved. New analyses use your key.') set({ notice: null });
  };

  const onRemember = (v: boolean) => {
    setRemember(v);
    // With nothing typed, the checkbox moves the saved key between session and device storage.
    if (!typed) {
      const k = getRoboflowKey();
      if (k) {
        setRoboflowKey(k, v, { explicit: false }); // keeps a "key required" prompt open
        setStatus(v ? 'Your key is now remembered on this device.' : 'Your key is now kept only for this browser session.');
      }
    }
  };

  const until = fmtReset(prompt?.resetsAt ?? quota?.resetsAt);
  const required = !!prompt;
  const checkMsg: { text: string; tone: 'muted' | 'ok' | 'bad' | 'warn' } | null =
    check.s === 'checking'
      ? { text: 'Checking with Roboflow…', tone: 'muted' }
      : check.s === 'ok'
        ? { text: check.ws ? `Key works · workspace ${check.ws}` : 'Key works', tone: 'ok' }
        : check.s === 'invalid'
          ? { text: "Roboflow doesn't recognise this key. Copy the Private API Key, not the publishable rf_… key.", tone: 'bad' }
          : check.s === 'publishable'
            ? { text: "That's the publishable key (rf_…). Copy the Private API Key instead.", tone: 'bad' }
            : check.s === 'network'
              ? { text: "Couldn't reach Roboflow to check. You can still save it; it will be checked on your next analysis.", tone: 'warn' }
              : check.s === 'format'
                ? { text: "That doesn't look like a Roboflow API key. Paste only the Private API Key, with no spaces.", tone: 'bad' }
                : confirmUnchecked
                  ? { text: 'This key has not been checked with Roboflow. Click "Save without checking" again to save it anyway.', tone: 'warn' }
                  : null;

  const tone = checkMsg?.tone;

  return (
    <Modal open={open} onClose={close} title={required ? REQUIRED_TITLE : 'Use your own Roboflow key (free)'} width={480}>
      <div className="space-y-4 text-xs leading-[18px] text-ink-300">
        {required ? (
          <div role="alert" className="space-y-1 rounded-lg bg-ink-800 px-3 py-2.5">
            <p className="text-paper">{requiredReason(prompt!.reason, until)}</p>
            <p className="text-[11px] leading-4 text-ink-300">
              {prompt!.autoRetry ? 'Once you save it, detection starts again by itself: no need to upload the photo again.' : 'Once you save it, new analyses use your key.'} A free Roboflow account needs no card.
            </p>
          </div>
        ) : (
          <>
            {exhaustedOnOpen && (
              <div role="alert" className="rounded-lg bg-ink-800 px-3 py-2.5 text-paper">
                This demo's shared Roboflow free-plan allowance is used up{until ? ` until ${until}` : ''}. Add your own free key to keep analysing photos. The examples still work.
              </div>
            )}
            <p>
              sunvisionai finds windows with a Roboflow RF-DETR model. The shared key here runs on Roboflow's free plan and stops when its monthly allowance runs out. A free Roboflow account gives you your own allowance, and no card is needed.
            </p>
          </>
        )}

        {hasKey && (
          <p className="flex items-start gap-2 text-ink-200">
            <span aria-hidden className={clsx(DOT, 'bg-obs')} />
            <span>
              Using your key · {isRoboflowKeyRemembered() ? 'remembered on this device' : 'kept for this browser session'}. Paste a new one to replace it.
            </span>
          </p>
        )}

        <ol className="list-decimal space-y-2 pl-4 text-ink-200 marker:text-[11px] marker:text-ink-400">
          <li className="pl-1">
            <Ext href="https://app.roboflow.com/login" className={STEP_LINK} icon>Create a free Roboflow account</Ext>
          </li>
          <li className="pl-1">
            <Ext href="https://app.roboflow.com/settings/api" className={STEP_LINK} icon>Copy your Private API Key (Settings → API Keys)</Ext>
          </li>
          <li className="pl-1">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runCheck();
              }}
            >
              <label htmlFor={inputId} className="mb-1.5 block text-[11px] font-semibold leading-4 text-paper">
                Private API key
              </label>
              <div className="flex items-stretch gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    id={inputId}
                    data-autofocus={finePointer() ? true : undefined}
                    type={show ? 'text' : 'password'}
                    value={value}
                    onChange={(e) => onInput(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    aria-describedby={`${helpId} ${statusId}`}
                    aria-invalid={check.s === 'invalid' || check.s === 'publishable' || check.s === 'format' ? true : undefined}
                    placeholder={hasKey ? 'Paste a new key to replace yours' : 'Paste your Private API Key'}
                    className="mono h-7 w-full rounded-md bg-ink-800 pl-2.5 pr-9 text-base text-paper outline-none transition-shadow placeholder:font-sans placeholder:text-ink-400 hover:ring-1 hover:ring-inset hover:ring-ink-700 focus:ring-1 focus:ring-inset focus:ring-accent aria-invalid:ring-1 aria-invalid:ring-inset aria-invalid:ring-danger pointer-coarse:h-11 pointer-coarse:pr-12 sm:text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Hide key' : 'Show key'}
                    aria-pressed={show}
                    className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-sm text-ink-400 transition-colors hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:right-0 pointer-coarse:h-11 pointer-coarse:w-11"
                  >
                    <EyeIcon off={show} />
                  </button>
                </div>
                <button type="submit" disabled={!typed || check.s === 'checking'} className={clsx(BTN, 'h-7 px-3 text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800')}>
                  Check key
                </button>
              </div>
            </form>
          </li>
        </ol>

        <div id={statusId} role="status" aria-live="polite" className="text-[11px] leading-4 empty:-mb-4">
          {checkMsg && (
            <p className={clsx('flex items-start gap-2', tone === 'bad' ? 'text-danger-text' : tone === 'muted' ? 'text-ink-400' : 'text-ink-200')}>
              <span aria-hidden className={clsx(DOT, tone === 'ok' && 'bg-obs', tone === 'bad' && 'bg-danger', tone === 'warn' && 'bg-sun-500', tone === 'muted' && 'animate-pulse bg-ink-400')} />
              <span>
                {checkMsg.text}
                {check.s === 'ok' && check.ws && (
                  <>
                    {' · '}
                    <Ext href={`https://app.roboflow.com/${encodeURIComponent(check.ws)}/settings/usage`} icon>Check usage</Ext>
                  </>
                )}
              </span>
            </p>
          )}
          {status && <p className="flex items-start gap-2 text-ink-200"><span aria-hidden className={clsx(DOT, 'bg-ink-400')} />{status}</p>}
        </div>

        <div className="space-y-1">
          <label className="flex min-h-7 cursor-pointer select-none items-center gap-2 text-xs text-ink-200 hover:text-paper pointer-coarse:min-h-11">
            <span className="relative grid h-3.5 w-3.5 shrink-0 place-items-center">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => onRemember(e.target.checked)}
                className="peer h-3.5 w-3.5 cursor-pointer appearance-none rounded-[3px] ring-1 ring-inset ring-ink-500 transition-colors checked:bg-accent checked:ring-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute text-on-accent opacity-0 peer-checked:opacity-100">
                <path d="M2 5.2l2 2L8 3" />
              </svg>
            </span>
            Remember on this device
          </label>
          <p id={helpId} className="pl-[22px] text-[11px] leading-4 text-ink-400">
            Stored only in this browser and sent with your own analysis requests to this sunvisionai server, which passes it to Roboflow. sunvisionai never stores or logs it.
          </p>
        </div>

        <p className="text-[11px] leading-4 text-ink-400">
          Detection powered by{' '}
          <Ext href="https://roboflow.com" className="font-medium">
            Roboflow
          </Ext>
          {' · Model: '}
          <Ext href="https://universe.roboflow.com/building-facade/building-facade-segmentation-instance">
            <i>building-facade-segmentation-instance</i> v4 by Building Facade on Roboflow Universe
          </Ext>
          {', '}
          <Ext href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</Ext>
        </p>

        <footer className="-mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t border-ink-700 px-4 py-3">
          {required && (
            <button type="button" onClick={markByHand} className={clsx(BTN, 'h-7', '-ml-2 px-2 text-accent-300 hover:bg-ink-800')}>
              Mark windows by hand instead
            </button>
          )}
          {hasKey && (
            <button type="button" onClick={removeKey} className={clsx(BTN, 'h-7', !required && '-ml-2', 'px-2 text-ink-300 hover:bg-ink-800 hover:text-paper')}>
              Remove key
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={close} className={clsx(BTN, 'h-7 px-3', 'text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800')}>
              {required ? 'Not now' : 'Cancel'}
            </button>
            <button type="button" onClick={save} disabled={blocked} className={clsx(BTN, 'h-7 px-3', 'bg-accent-500 text-on-accent hover:bg-accent-600 disabled:hover:bg-accent-500')}>
              {saveLabel}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
