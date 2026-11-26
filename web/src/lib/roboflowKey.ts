/**
 * The user's own Roboflow Private API key (bring your own key, docs/research/byok.md §5.1).
 *
 * Rules this module enforces:
 * - The key lives only in browser storage: sessionStorage by default, localStorage only when the user ticks
 *   "Remember on this device". Saving in one store clears the other.
 * - Every storage access is wrapped in try/catch (private mode, blocked site data, SSR, tests).
 * - The key is never put in the zustand store, scene JSON, URLs, query strings or logs. It leaves the browser
 *   only as the `X-Roboflow-Key` request header to our own API, and as an `Authorization: Bearer` header when
 *   the user clicks "Check key" (GET https://api.roboflow.com/, which is CORS-open, byok.md §1).
 * - Nothing in this file calls `console.*`.
 */

export const ROBOFLOW_KEY_STORAGE = 'sv.roboflowKey';
export const ROBOFLOW_VALIDATE_URL = 'https://api.roboflow.com/';
/** The API rejects longer values with 400 `user_key_format` (byok.md §5.1). */
export const MAX_KEY_LENGTH = 128;

export type KeyCheckReason = 'invalid' | 'network' | 'publishable' | 'format' | 'empty';
export interface KeyCheckResult {
  ok: boolean;
  /** Roboflow workspace slug the key belongs to, when Roboflow reports it. */
  workspace?: string;
  reason?: KeyCheckReason;
}

type StoreName = 'sessionStorage' | 'localStorage';

function storage(name: StoreName): Storage | null {
  try {
    const s = (globalThis as unknown as Record<StoreName, Storage | undefined>)[name];
    return s ?? null;
  } catch {
    return null;
  }
}

function read(name: StoreName): string | null {
  try {
    const v = storage(name)?.getItem(ROBOFLOW_KEY_STORAGE);
    const t = typeof v === 'string' ? v.trim() : '';
    return t ? t : null;
  } catch {
    return null;
  }
}

function write(name: StoreName, value: string): boolean {
  try {
    const s = storage(name);
    if (!s) return false;
    s.setItem(ROBOFLOW_KEY_STORAGE, value);
    return true;
  } catch {
    return false;
  }
}

function remove(name: StoreName): void {
  try {
    storage(name)?.removeItem(ROBOFLOW_KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

// ---- change notification (so the pill and the upload flow can react without holding the key) ----------

const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener's failure must not break saving */
    }
  }
}

let storageListenerInstalled = false;
function installStorageListener() {
  if (storageListenerInstalled) return;
  storageListenerInstalled = true;
  try {
    // Another tab changed localStorage (remember / remove on this device).
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key === null || e.key === ROBOFLOW_KEY_STORAGE) emit();
    });
  } catch {
    /* no window */
  }
}

/** Subscribe to key changes (save, remove, another tab). Returns an unsubscribe function. The callback gets no key. */
export function subscribeRoboflowKey(cb: () => void): () => void {
  installStorageListener();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Monotonic counter that changes on every key change; a cheap snapshot for `useSyncExternalStore`. */
export function roboflowKeyVersion(): number {
  return version;
}

// ---- public API --------------------------------------------------------------------------------------

/** The saved key (sessionStorage first, then localStorage), trimmed, or null. */
export function getRoboflowKey(): string | null {
  return read('sessionStorage') ?? read('localStorage');
}

export function hasRoboflowKey(): boolean {
  return getRoboflowKey() !== null;
}

/** True when the saved key is in localStorage ("Remember on this device"). */
export function isRoboflowKeyRemembered(): boolean {
  return read('sessionStorage') === null && read('localStorage') !== null;
}

/**
 * Save the key. `remember` → localStorage, otherwise sessionStorage; the other store is cleared.
 * An empty value clears the key. If the chosen store is unavailable the key is not saved anywhere else.
 */
export function setRoboflowKey(k: string, remember: boolean, opts: { explicit?: boolean } = {}): void {
  const key = (k ?? '').trim();
  if (!key) {
    clearRoboflowKey();
    return;
  }
  if (remember) {
    remove('sessionStorage');
    write('localStorage', key);
  } else {
    remove('localStorage');
    write('sessionStorage', key);
  }
  const explicit = opts.explicit !== false;
  // An explicit save answers the "key required" prompt; detection retries through the save listeners.
  // Moving the saved key between session and device storage (explicit: false) answers nothing.
  if (explicit && prompt) {
    prompt = null;
    emitPrompt();
  }
  emit();
  if (explicit) for (const l of [...savedListeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

const savedListeners = new Set<() => void>();
/**
 * Subscribe to explicit saves (the dialog's Save, even when the key is unchanged: e.g. the user
 * topped up their Roboflow credits and saved the same key again). Not fired by the "Remember on
 * this device" toggle, by removal or by other tabs. Returns an unsubscribe function.
 */
export function subscribeRoboflowKeySaved(cb: () => void): () => void {
  savedListeners.add(cb);
  return () => {
    savedListeners.delete(cb);
  };
}

/** Remove the key from both stores. */
export function clearRoboflowKey(): void {
  remove('sessionStorage');
  remove('localStorage');
  emit();
}

/** `{ 'X-Roboflow-Key': key }` when a key is saved, else `{}`. Header only, never a query parameter. */
export function keyHeaders(): Record<string, string> {
  const k = getRoboflowKey();
  return k ? { 'X-Roboflow-Key': k } : {};
}

/** Publishable keys (`rf_<workspaceId>`) are browser-safe but cannot run Universe models through our API. */
export function looksPublishable(k: string): boolean {
  return (k ?? '').trim().startsWith('rf_');
}

/** Same rule as the API: ≤128 printable ASCII characters, no spaces inside. */
export function isPlausibleKeyFormat(k: string): boolean {
  const key = (k ?? '').trim();
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key);
}

/**
 * Check a pasted key directly with Roboflow: `GET https://api.roboflow.com/` with `Authorization: Bearer`.
 * - `rf_…` → `{ ok: false, reason: 'publishable' }` without any network call.
 * - 200 → `{ ok: true, workspace }` (workspace slug when the response names one).
 * - 401 / 403 → `invalid`. Anything else, or no answer → `network` (could not check).
 * Aborting via `signal` rethrows the AbortError. Runs only on an explicit user action.
 */
export async function validateRoboflowKey(k: string, signal?: AbortSignal): Promise<KeyCheckResult> {
  const key = (k ?? '').trim();
  if (!key) return { ok: false, reason: 'empty' };
  if (looksPublishable(key)) return { ok: false, reason: 'publishable' };
  if (!isPlausibleKeyFormat(key)) return { ok: false, reason: 'format' };
  let res: Response;
  try {
    res = await fetch(ROBOFLOW_VALIDATE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, reason: 'network' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid' };
  if (!res.ok) return { ok: false, reason: 'network' };
  let workspace: string | undefined;
  try {
    const body = (await res.json()) as unknown;
    const ws = body && typeof body === 'object' ? (body as Record<string, unknown>).workspace : undefined;
    if (typeof ws === 'string' && ws.trim()) workspace = ws.trim();
  } catch (e) {
    if (signal?.aborted) throw e;
    /* a 200 without a JSON body still means the key was accepted */
  }
  return workspace ? { ok: true, workspace } : { ok: true };
}

// ---- "key required" prompt ---------------------------------------------------------------------------
//
// Why the key dialog is open, when automatic detection is blocked for want of a (working) key. The dialog
// shows its "required" variant while a prompt is set. Holds no key; cleared when a key is saved.

export interface KeyPrompt {
  /** Our API's error code that a key would fix (e.g. 'shared_quota_exhausted', 'shared_key_unavailable'). */
  reason: string;
  /** True when detection re-runs by itself once a key is saved (the upload flow arms this). */
  autoRetry: boolean;
  /** "Mark windows by hand instead": what the escape does in the current context. */
  onManual?: () => void;
  /** Reset date of the shared allowance, when the server reported one (ISO). */
  resetsAt?: string | null;
}

let prompt: KeyPrompt | null = null;
const promptListeners = new Set<() => void>();

function emitPrompt() {
  for (const l of [...promptListeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/** Set (or clear with null) the reason the key dialog is asking for a key. */
export function setKeyPrompt(p: KeyPrompt | null): void {
  prompt = p;
  emitPrompt();
}

export function getKeyPrompt(): KeyPrompt | null {
  return prompt;
}

export function subscribeKeyPrompt(cb: () => void): () => void {
  promptListeners.add(cb);
  return () => {
    promptListeners.delete(cb);
  };
}

// ---- short names (aliases of the functions above) ----------------------------------------------------

export const getKey = getRoboflowKey;
export const setKey = setRoboflowKey;
export const clearKey = clearRoboflowKey;

/** Simplified result of `validateRoboflowKey`. `format` and `empty` are reported as `invalid`. */
export async function checkKey(
  key: string,
  signal?: AbortSignal,
): Promise<{ ok: true; workspace: string | null } | { ok: false; reason: 'invalid' | 'network' | 'publishable' }> {
  const r = await validateRoboflowKey(key, signal);
  if (r.ok) return { ok: true, workspace: r.workspace ?? null };
  const reason = r.reason === 'network' || r.reason === 'publishable' ? r.reason : 'invalid';
  return { ok: false, reason };
}
