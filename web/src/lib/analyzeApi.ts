/**
 * Client for our own sunvisionai API (`/api/analyze`, `/api/health`), docs/research/byok.md §5.
 *
 * - The user's Roboflow key travels only as the `X-Roboflow-Key` header (lib/roboflowKey.ts); never in the URL.
 * - Error responses `{ detail: { code, message, ... } }` become `AnalyzeError` with our API's error codes
 *   (byok.md §5.3). Transport failures get client-side codes: `network`, `api_unavailable`, `bad_response`.
 * - `store.sharedQuota` is refreshed from `/api/health` and updated immediately on `shared_quota_exhausted`.
 * - Errors that a key would fix open the key dialog and set a `roboflow-key` notice.
 * - Nothing here logs request headers, the key or the response body.
 * - `VITE_API_BASE_URL` (build time) points the calls at an API on another origin;
 *   unset, they stay relative (`/api/...`, same origin or the Vite dev proxy).
 */
import type { FacadeAnalysis } from '../schema/scene';
import { useStore } from '../state/store';
import { getKeyPrompt, hasRoboflowKey, keyHeaders, setKeyPrompt, type KeyPrompt } from './roboflowKey';

/** Origin of the API from `VITE_API_BASE_URL`, without a trailing slash; '' keeps requests relative. */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '');

/** `path` (starting with `/api/`) on the configured API origin, or unchanged when none is set. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export type SharedQuota = NonNullable<ReturnType<typeof useStore.getState>['sharedQuota']>;

/** `/api/health` response. Fields beyond `status` are optional so a minimal answer still parses. */
export interface ApiHealth {
  status: string;
  pipelineVersion?: string;
  facadeModel?: string;
  /** A shared Roboflow key is configured on the server (the key itself is never sent). */
  apiKeyConfigured?: boolean;
  providers?: { hosted?: boolean; local?: boolean };
  depth?: { transformers?: boolean; inferenceModels?: boolean };
  maxUploadBytes?: number;
  /** `available: false` = the server lacks the Roboflow SDK, so no key (shared or own) can run detection. */
  byok?: { header?: string; available?: boolean };
  /** byok.md §5.2 rule 5. `remaining` is this server's own counter, not Roboflow's. */
  sharedQuota?: SharedQuota | null;
}

/** Our API's error codes (byok.md §5.3) plus image validation and client-side transport codes. */
export type AnalyzeErrorCode =
  | 'shared_quota_exhausted'
  | 'shared_rate_limited'
  | 'shared_key_unavailable'
  | 'user_key_invalid'
  | 'user_key_no_credits'
  | 'user_key_forbidden'
  | 'user_billing_paused'
  | 'user_key_format'
  | 'provider_rate_limited'
  | 'model_unavailable'
  | 'inference_timeout'
  | 'provider_error'
  | 'provider_not_installed'
  | 'too_large'
  | 'unsupported_type'
  | 'invalid_image'
  | 'bad_request'
  | 'network'
  | 'api_unavailable'
  | 'bad_response'
  | (string & {});

export class AnalyzeError extends Error {
  code: string;
  status: number;
  /** The server's `detail` object (code, message, resetsAt, cap, used, byokUrl, usageUrl, providerStatus…). */
  detail?: unknown;
  /** Seconds from the `Retry-After` header, when the server sent one. */
  retryAfter?: number;
  constructor(code: string, status: number, message: string, detail?: unknown, retryAfter?: number) {
    super(message);
    this.name = 'AnalyzeError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    if (retryAfter != null) this.retryAfter = retryAfter;
  }
}

/**
 * Codes that a (different) user key fixes: they open the key dialog in its "required" variant
 * (the demo's premise: when a key is what's missing, ask for it).
 */
export const KEY_DIALOG_CODES: readonly string[] = [
  'shared_quota_exhausted',
  'shared_rate_limited',
  'shared_key_unavailable',
  'user_key_invalid',
  'user_key_format',
  'user_key_forbidden',
  'user_key_no_credits',
  'user_billing_paused',
  'missing_api_key',
];

/** The detection server cannot be reached: a key would not help. */
const SERVER_DOWN_CODES: readonly string[] = ['network', 'api_unavailable'];
/** The photo itself, or a server without the Roboflow SDK: neither a key nor a retry helps. */
const MANUAL_CODES: readonly string[] = ['provider_not_installed', 'too_large', 'unsupported_type', 'invalid_image', 'bad_request'];

/**
 * What the upload flow does about automatic window detection:
 *  - 'ok'          run (or keep) detection;
 *  - 'ask-key'     a key is what's missing: ask for it right there, retry once it is saved;
 *  - 'server-down' the detection server is unreachable: say so (a key would not help), offer retry + manual;
 *  - 'retry'       a transient failure (timeout, provider busy): offer retry + manual;
 *  - 'manual'      nothing automatic will work for this photo / server: mark windows by hand.
 */
export type DetectionGate = 'ok' | 'ask-key' | 'server-down' | 'retry' | 'manual';

/**
 * `health`: the /api/health answer, `null` when the API is unreachable, `undefined` when not known
 * (do not block on it). `error`: the last analysis error, if any (it wins over `health`).
 * Returns the gate and, for 'ask-key', the error code that explains why.
 */
export function detectionCheck(health: ApiHealth | null | undefined, hasKey: boolean, error?: { code: string } | null): { gate: DetectionGate; code: string | null } {
  if (error) {
    const c = error.code;
    if (KEY_DIALOG_CODES.includes(c)) return { gate: 'ask-key', code: c === 'missing_api_key' ? (hasKey ? 'user_key_invalid' : 'shared_key_unavailable') : c };
    if (SERVER_DOWN_CODES.includes(c)) return { gate: 'server-down', code: c };
    if (MANUAL_CODES.includes(c)) return { gate: 'manual', code: c };
    return { gate: 'retry', code: c };
  }
  if (health === null) return { gate: 'server-down', code: 'api_unavailable' };
  if (health === undefined) return { gate: 'ok', code: null };
  if (health.byok?.available === false) return { gate: 'manual', code: 'provider_not_installed' };
  if (hasKey) return { gate: 'ok', code: null };
  const q = health.sharedQuota;
  if (q) {
    // Only `exhausted` means used up: remaining can be 0 while the last slots are merely reserved
    // by requests in flight (released seconds later); the server's reserve() decides (402 if full).
    if (q.exhausted) return { gate: 'ask-key', code: 'shared_quota_exhausted' };
    if (!q.enabled) return { gate: 'ask-key', code: 'shared_key_unavailable' };
    return { gate: 'ok', code: null };
  }
  if (health.apiKeyConfigured === false) return { gate: 'ask-key', code: 'shared_key_unavailable' };
  return { gate: 'ok', code: null };
}

/** `detectionCheck(...).gate`. */
export function detectionGate(health: ApiHealth | null | undefined, hasKey: boolean, error?: { code: string } | null): DetectionGate {
  return detectionCheck(health, hasKey, error).gate;
}

/**
 * Ask for the user's Roboflow key: open the key dialog in its "required" variant and set the
 * `roboflow-key` notice. `autoRetry` / `onManual` from an existing prompt are kept unless given.
 */
export function askForKey(reason: string, opts: Partial<Omit<KeyPrompt, 'reason'>> & { notice?: boolean } = {}): void {
  const prev = getKeyPrompt();
  const s = useStore.getState();
  setKeyPrompt({
    reason,
    // Inherited from the current prompt only when the caller does not say (analyzePhoto re-asking
    // inside an armed upload); a caller that passes the field, even as undefined, sets it.
    autoRetry: 'autoRetry' in opts ? !!opts.autoRetry : (prev?.autoRetry ?? false),
    onManual: 'onManual' in opts ? opts.onManual : prev?.onManual,
    resetsAt: opts.resetsAt ?? s.sharedQuota?.resetsAt ?? prev?.resetsAt ?? null,
  });
  const patch: Partial<ReturnType<typeof useStore.getState>> = { keyDialogOpen: true };
  if (opts.notice !== false) {
    const n = noticeForError(new AnalyzeError(reason, 0, reason));
    patch.notice = { kind: n.kind, text: n.text, action: n.action };
  }
  s.set(patch);
}

// ---- helpers -----------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return s;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : undefined;
}

/** Normalise a `sharedQuota` block from the server; null when it is not a usable object. */
export function parseSharedQuota(v: unknown): SharedQuota | null {
  if (!isObj(v)) return null;
  return {
    enabled: v.enabled === true,
    remaining: numOrNull(v.remaining),
    cap: numOrNull(v.cap),
    resetsAt: strOrNull(v.resetsAt),
    exhausted: v.exhausted === true,
  };
}

/** Map a non-OK response body to an AnalyzeError. Exported for tests. */
export function errorFromResponse(status: number, body: unknown, retryAfterHeader: string | null = null, userKey = hasRoboflowKey()): AnalyzeError {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const detail = isObj(body) ? body.detail : undefined;
  if (isObj(detail) && typeof detail.code === 'string') {
    let code = detail.code;
    // byok.md §5.3: `missing_api_key` is a generic alias, mapped to the specific key error here.
    if (code === 'missing_api_key') code = userKey ? 'user_key_invalid' : 'shared_key_unavailable';
    const message = typeof detail.message === 'string' && detail.message ? detail.message : `Analysis failed (HTTP ${status})`;
    return new AnalyzeError(code, status, message, detail, retryAfter);
  }
  if (status === 422 || (status === 400 && detail !== undefined)) {
    return new AnalyzeError('bad_request', status, 'The analysis request was rejected by the server.', detail, retryAfter);
  }
  if (status === 413) return new AnalyzeError('too_large', status, 'The photo is too large for the server.', detail, retryAfter);
  if (body === undefined && (status === 404 || status >= 500)) {
    // No JSON at all: typically the dev proxy with no API behind it, or a static host without /api.
    return new AnalyzeError('api_unavailable', status, "The sunvisionai detection server isn't reachable.", undefined, retryAfter);
  }
  return new AnalyzeError('bad_response', status, `Analysis failed (HTTP ${status})`, detail, retryAfter);
}

function setSharedQuota(q: SharedQuota | null) {
  useStore.getState().set({ sharedQuota: q });
}

/** Reflect a 402 `shared_quota_exhausted` immediately; the health refresh follows. */
function markExhausted(detail: unknown) {
  const prev = useStore.getState().sharedQuota;
  const d = isObj(detail) ? detail : {};
  setSharedQuota({
    enabled: prev?.enabled ?? true,
    remaining: prev?.remaining != null ? 0 : null,
    cap: numOrNull(d.cap) ?? prev?.cap ?? null,
    resetsAt: strOrNull(d.resetsAt) ?? prev?.resetsAt ?? null,
    exhausted: true,
  });
}

// ---- health ------------------------------------------------------------------------------------------

let healthInFlight: Promise<ApiHealth | null> | null = null;

/**
 * GET /api/health. Sets `store.sharedQuota` from its `sharedQuota` block. An answer without that block
 * gets `{ enabled: apiKeyConfigured, remaining: null, … }`: no number is ever invented.
 * Returns null (and sets `sharedQuota` to null) when the API is unreachable. Concurrent calls share one request.
 */
export function fetchHealth(): Promise<ApiHealth | null> {
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    try {
      const r = await fetch(apiUrl('/api/health'), { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('health');
      const j = (await r.json()) as unknown;
      if (!isObj(j) || typeof j.status !== 'string') throw new Error('health');
      const h = j as unknown as ApiHealth;
      const q = parseSharedQuota(j.sharedQuota);
      const derived: SharedQuota = { enabled: h.apiKeyConfigured === true, remaining: null, cap: null, resetsAt: null, exhausted: false };
      setSharedQuota(q ?? derived);
      return { ...h, sharedQuota: q };
    } catch {
      setSharedQuota(null);
      return null;
    } finally {
      healthInFlight = null;
    }
  })();
  return healthInFlight;
}

/** The shared quota from /api/health, or null. */
export async function fetchSharedQuota(): Promise<SharedQuota | null> {
  const h = await fetchHealth();
  return h ? useStore.getState().sharedQuota : null;
}

// ---- analyze -----------------------------------------------------------------------------------------

/**
 * POST /api/analyze with the photo as multipart `file`. Adds `X-Roboflow-Key` when the user saved a key.
 * Throws `AnalyzeError` on any failure; an abort through `signal` rethrows the AbortError unchanged.
 */
export async function analyzePhoto(
  file: Blob,
  opts: { provider?: 'hosted' | 'local'; depth?: boolean; signal?: AbortSignal } = {},
): Promise<FacadeAnalysis & { privacy?: Record<string, unknown> }> {
  const provider = opts.provider ?? 'hosted';
  const depth = opts.depth ?? true;
  const fd = new FormData();
  const name = typeof File !== 'undefined' && file instanceof File && file.name ? file.name : 'photo.jpg';
  fd.append('file', file, name);
  const qs = new URLSearchParams({ provider, depth: String(depth) });

  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/analyze?${qs.toString()}`), {
      method: 'POST',
      body: fd,
      headers: { Accept: 'application/json', ...keyHeaders() },
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = new AnalyzeError('network', 0, "Couldn't reach the sunvisionai detection server.");
    void fetchHealth();
    throw err;
  }

  let body: unknown = undefined;
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) body = await res.json();
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    body = undefined;
  }

  if (!res.ok) {
    const err = errorFromResponse(res.status, body, res.headers.get('retry-after'));
    if (err.code === 'shared_quota_exhausted') markExhausted(err.detail);
    if (KEY_DIALOG_CODES.includes(err.code)) {
      const d = isObj(err.detail) ? err.detail : {};
      askForKey(err.code, { resetsAt: strOrNull(d.resetsAt) });
    }
    void fetchHealth();
    throw err;
  }

  if (!isObj(body) || !Array.isArray(body.detections)) {
    void fetchHealth();
    throw new AnalyzeError('bad_response', res.status, 'The analysis server returned an unexpected response.');
  }
  void fetchHealth();
  return body as unknown as FacadeAnalysis & { privacy?: Record<string, unknown> };
}

// ---- notice copy (byok.md §5.4) --------------------------------------------------------------------

export function noticeForError(e: AnalyzeError): { kind: 'warning' | 'error'; text: string; action?: 'roboflow-key' | 'mark-windows' | 'retry' } {
  switch (e.code) {
    case 'shared_quota_exhausted':
      return { kind: 'warning', action: 'roboflow-key', text: "This demo's shared Roboflow allowance is used up for this month. Add your own free key to keep analysing photos; the examples still work." };
    case 'shared_rate_limited':
      return { kind: 'warning', action: 'roboflow-key', text: "You've used today's free analyses on the shared key. Add your own free Roboflow key to continue now, or try again tomorrow." };
    case 'shared_key_unavailable':
      return { kind: 'warning', action: 'roboflow-key', text: 'This server has no shared Roboflow key. Add your own free key to analyse photos.' };
    case 'user_key_invalid':
      return { kind: 'error', action: 'roboflow-key', text: 'Roboflow rejected your key. Check that you copied the Private API Key.' };
    case 'user_key_no_credits':
      return { kind: 'warning', action: 'roboflow-key', text: 'Your Roboflow workspace is out of credits this month. Check your usage on roboflow.com, or mark windows by hand.' };
    case 'user_key_forbidden':
      return { kind: 'error', action: 'roboflow-key', text: "Your key works but can't run the facade model. Check that it can use public Universe models." };
    case 'user_billing_paused':
      return { kind: 'warning', action: 'roboflow-key', text: 'Billing for your Roboflow workspace is paused. Check your plan on roboflow.com, or mark windows by hand.' };
    case 'user_key_format':
      return { kind: 'error', action: 'roboflow-key', text: "That doesn't look like a Roboflow API key. Paste the Private API Key again." };
    case 'provider_rate_limited':
      return { kind: 'warning', action: 'retry', text: 'Roboflow is busy. Try again in a moment.' };
    case 'too_large':
      return { kind: 'error', action: 'mark-windows', text: 'This photo is too large to analyse (up to 15 MB and 40 megapixels). Use a smaller copy, or mark windows by hand.' };
    case 'unsupported_type':
    case 'invalid_image':
      return { kind: 'error', action: 'mark-windows', text: "This file couldn't be read as a JPG, PNG or WebP photo. Try another file, or mark windows by hand." };
    case 'network':
    case 'api_unavailable':
      return { kind: 'warning', action: 'retry', text: "The detection server isn't reachable, so windows can't be found automatically (a Roboflow key wouldn't help). Try again, or mark the windows yourself." };
    case 'provider_not_installed':
      return { kind: 'warning', action: 'mark-windows', text: "This server isn't set up to run Roboflow detection, so a key wouldn't help. Mark the windows yourself." };
    default:
      // model_unavailable, inference_timeout, provider_error, bad_request, bad_response, unknown codes.
      return { kind: 'error', action: 'retry', text: 'Detection failed.' };
  }
}
