import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyzeError, analyzePhoto, askForKey, detectionCheck, detectionGate, errorFromResponse, fetchHealth, noticeForError, type ApiHealth } from '../analyzeApi';
import { clearRoboflowKey, getKeyPrompt, setKeyPrompt, setRoboflowKey } from '../roboflowKey';
import { useStore } from '../../state/store';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

const KEY = 'TESTKEY0000fake0000';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const ANALYSIS = { model: { provider: 'roboflow-hosted', modelId: 'm/4' }, imageWidth: 10, imageHeight: 10, detections: [], floorRows: [], warnings: [], pipelineVersion: 'x' };
const HEALTH = { status: 'ok', apiKeyConfigured: true, sharedQuota: { enabled: true, remaining: 1863, cap: 2000, resetsAt: '2026-12-01T00:00:00Z', exhausted: false } };

/** Routes /api/health to `health` and /api/analyze to `analyze`. */
function mockApi(analyze: () => Response | Promise<Response>, health: () => Response | Promise<Response> = () => json(200, HEALTH)) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).startsWith('/api/health') ? health() : analyze()));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function analyzeError(p: Promise<unknown>): Promise<AnalyzeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AnalyzeError);
    return e as AnalyzeError;
  }
  throw new Error('expected an AnalyzeError');
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemStorage());
  vi.stubGlobal('localStorage', new MemStorage());
  clearRoboflowKey();
  useStore.getState().set({ sharedQuota: null, keyDialogOpen: false, notice: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('analyzePhoto request', () => {
  it('POSTs multipart to /api/analyze without X-Roboflow-Key when no key is saved', async () => {
    const fn = mockApi(() => json(200, ANALYSIS));
    const r = await analyzePhoto(photo(), { provider: 'hosted', depth: false });
    expect(r.detections).toEqual([]);
    const call = fn.mock.calls.find(([u]) => String(u).startsWith('/api/analyze'))!;
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('/api/analyze?provider=hosted&depth=false');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(init.headers as Record<string, string>).not.toHaveProperty('X-Roboflow-Key');
  });

  it('adds X-Roboflow-Key (header only, never in the URL) when a key is saved', async () => {
    setRoboflowKey(KEY, false);
    const fn = mockApi(() => json(200, ANALYSIS));
    await analyzePhoto(photo());
    const [url, init] = fn.mock.calls.find(([u]) => String(u).startsWith('/api/analyze')) as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Roboflow-Key']).toBe(KEY);
    expect(url).not.toContain(KEY);
    expect(url).toBe('/api/analyze?provider=hosted&depth=true');
    // The key never reaches the zustand store.
    expect(JSON.stringify(useStore.getState())).not.toContain(KEY);
  });

  it('refreshes store.sharedQuota after an analysis', async () => {
    mockApi(() => json(200, ANALYSIS));
    await analyzePhoto(photo());
    await settle();
    expect(useStore.getState().sharedQuota).toEqual(HEALTH.sharedQuota);
  });
});

describe('analyzePhoto error mapping (byok.md §5.3)', () => {
  const cases: [number, string][] = [
    [402, 'shared_quota_exhausted'],
    [429, 'shared_rate_limited'],
    [503, 'shared_key_unavailable'],
    [401, 'user_key_invalid'],
    [402, 'user_key_no_credits'],
    [403, 'user_key_forbidden'],
    [423, 'user_billing_paused'],
    [400, 'user_key_format'],
    [429, 'provider_rate_limited'],
    [404, 'model_unavailable'],
    [504, 'inference_timeout'],
    [502, 'provider_error'],
    [413, 'too_large'],
    [400, 'unsupported_type'],
  ];
  for (const [status, code] of cases) {
    it(`${status} ${code}`, async () => {
      mockApi(() => json(status, { detail: { code, message: 'server says no' } }, code.endsWith('rate_limited') ? { 'Retry-After': '30' } : {}));
      const e = await analyzeError(analyzePhoto(photo()));
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(e.message).toBe('server says no');
      expect((e.detail as { code: string }).code).toBe(code);
      if (code.endsWith('rate_limited')) expect(e.retryAfter).toBe(30);
      const n = noticeForError(e);
      expect(n.text.length).toBeGreaterThan(0);
      expect(['warning', 'error']).toContain(n.kind);
    });
  }

  it('402 shared_quota_exhausted marks the quota exhausted, opens the key dialog and sets the notice', async () => {
    useStore.getState().set({ sharedQuota: { enabled: true, remaining: 3, cap: 2000, resetsAt: null, exhausted: false } });
    mockApi(
      () => json(402, { detail: { code: 'shared_quota_exhausted', message: 'used up', resetsAt: '2026-12-01T00:00:00Z', cap: 2000, used: 2000 } }),
      // Health answers late, so the immediate update is what we see first.
      () => new Promise<Response>((r) => setTimeout(() => r(json(200, { status: 'ok', sharedQuota: { enabled: true, remaining: 0, cap: 2000, resetsAt: '2026-12-01T00:00:00Z', exhausted: true } })), 20)),
    );
    const e = await analyzeError(analyzePhoto(photo()));
    expect(e.code).toBe('shared_quota_exhausted');
    const s = useStore.getState();
    expect(s.sharedQuota).toEqual({ enabled: true, remaining: 0, cap: 2000, resetsAt: '2026-12-01T00:00:00Z', exhausted: true });
    expect(s.keyDialogOpen).toBe(true);
    expect(s.notice?.action).toBe('roboflow-key');
    expect(s.notice?.text).toBe("This demo's shared Roboflow allowance is used up for this month. Add your own free key to keep analysing photos; the examples still work.");
    await new Promise((r) => setTimeout(r, 40));
    expect(useStore.getState().sharedQuota?.exhausted).toBe(true);
  });

  it('provider errors do not open the key dialog', async () => {
    mockApi(() => json(504, { detail: { code: 'inference_timeout', message: 'slow' } }));
    await analyzeError(analyzePhoto(photo()));
    expect(useStore.getState().keyDialogOpen).toBe(false);
  });

  it('maps the missing_api_key alias by key source', () => {
    expect(errorFromResponse(503, { detail: { code: 'missing_api_key', message: 'x' } }, null, false).code).toBe('shared_key_unavailable');
    expect(errorFromResponse(503, { detail: { code: 'missing_api_key', message: 'x' } }, null, true).code).toBe('user_key_invalid');
  });

  it('FastAPI validation errors become bad_request', () => {
    const e = errorFromResponse(422, { detail: [{ loc: ['query', 'confidence'], msg: 'bad' }] });
    expect(e.code).toBe('bad_request');
  });

  it('a non-JSON 5xx (dev proxy, no API) becomes api_unavailable', async () => {
    mockApi(() => new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }));
    const e = await analyzeError(analyzePhoto(photo()));
    expect(e.code).toBe('api_unavailable');
    // A key would not help: say the server is unreachable and offer a retry (plus marking by hand).
    expect(noticeForError(e)).toEqual({ kind: 'warning', action: 'retry', text: "The detection server isn't reachable, so windows can't be found automatically (a Roboflow key wouldn't help). Try again, or mark the windows yourself." });
  });

  it('a network failure becomes network', async () => {
    mockApi(() => {
      throw new TypeError('Failed to fetch');
    });
    const e = await analyzeError(analyzePhoto(photo()));
    expect(e.code).toBe('network');
    expect(e.status).toBe(0);
  });

  it('an OK response without detections becomes bad_response', async () => {
    mockApi(() => json(200, { hello: 'world' }));
    const e = await analyzeError(analyzePhoto(photo()));
    expect(e.code).toBe('bad_response');
  });

  it('an abort rethrows the AbortError unchanged', async () => {
    const ac = new AbortController();
    mockApi(() => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(analyzePhoto(photo(), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('noticeForError copy', () => {
  const copy: Record<string, string> = {
    shared_quota_exhausted: "This demo's shared Roboflow allowance is used up for this month. Add your own free key to keep analysing photos; the examples still work.",
    shared_rate_limited: "You've used today's free analyses on the shared key. Add your own free Roboflow key to continue now, or try again tomorrow.",
    shared_key_unavailable: 'This server has no shared Roboflow key. Add your own free key to analyse photos.',
    user_key_invalid: 'Roboflow rejected your key. Check that you copied the Private API Key.',
    user_key_no_credits: 'Your Roboflow workspace is out of credits this month. Check your usage on roboflow.com, or mark windows by hand.',
    user_key_forbidden: "Your key works but can't run the facade model. Check that it can use public Universe models.",
    provider_rate_limited: 'Roboflow is busy. Try again in a moment.',
  };
  for (const [code, text] of Object.entries(copy)) {
    it(code, () => expect(noticeForError(new AnalyzeError(code, 400, 'x')).text).toBe(text));
  }
  it('key problems route to the key dialog', () => {
    for (const c of ['shared_quota_exhausted', 'shared_rate_limited', 'shared_key_unavailable', 'user_key_invalid', 'user_key_forbidden', 'user_key_format', 'user_key_no_credits', 'user_billing_paused'])
      expect(noticeForError(new AnalyzeError(c, 400, 'x')).action).toBe('roboflow-key');
  });
  it('unknown failures offer a retry', () => {
    expect(noticeForError(new AnalyzeError('provider_error', 502, 'x'))).toEqual({ kind: 'error', action: 'retry', text: 'Detection failed.' });
  });
});

describe('fetchHealth', () => {
  it('reads sharedQuota into the store', async () => {
    mockApi(() => json(200, ANALYSIS));
    const h = await fetchHealth();
    expect(h?.status).toBe('ok');
    expect(useStore.getState().sharedQuota).toEqual(HEALTH.sharedQuota);
  });

  it('a server without sharedQuota yields no number', async () => {
    mockApi(() => json(200, ANALYSIS), () => json(200, { status: 'ok', apiKeyConfigured: true }));
    await fetchHealth();
    expect(useStore.getState().sharedQuota).toEqual({ enabled: true, remaining: null, cap: null, resetsAt: null, exhausted: false });
  });

  it('an unreachable API sets sharedQuota to null and returns null', async () => {
    useStore.getState().set({ sharedQuota: { enabled: true, remaining: 1, cap: 1, resetsAt: null, exhausted: false } });
    mockApi(() => json(200, ANALYSIS), () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchHealth()).toBeNull();
    expect(useStore.getState().sharedQuota).toBeNull();
  });

  it('ignores malformed quota numbers', async () => {
    mockApi(() => json(200, ANALYSIS), () => json(200, { status: 'ok', sharedQuota: { enabled: true, remaining: 'lots', cap: null, exhausted: false } }));
    await fetchHealth();
    expect(useStore.getState().sharedQuota?.remaining).toBeNull();
  });
});

describe('detectionGate (the "key required" premise)', () => {
  const q = (p: Partial<NonNullable<ApiHealth['sharedQuota']>>) => ({ enabled: true, remaining: 10, cap: 2000, resetsAt: '2026-12-01T00:00:00Z', exhausted: false, ...p });
  const health = (p: Partial<ApiHealth> = {}): ApiHealth => ({ status: 'ok', apiKeyConfigured: true, byok: { header: 'X-Roboflow-Key', available: true }, sharedQuota: q({}), ...p });
  const err = (code: string) => new AnalyzeError(code, 400, code);

  it('runs when the shared allowance has room, or when the user has a key', () => {
    expect(detectionGate(health(), false)).toBe('ok');
    expect(detectionGate(health({ sharedQuota: q({ exhausted: true, remaining: 0 }) }), true)).toBe('ok');
    expect(detectionGate(health({ sharedQuota: q({ enabled: false, remaining: null, cap: null }) }), true)).toBe('ok');
  });

  it('does not block on an unknown health answer (slow /api/health)', () => {
    expect(detectionGate(undefined, false)).toBe('ok');
  });

  it('asks for a key up front when the shared key is exhausted, disabled or absent and the user has none', () => {
    expect(detectionCheck(health({ sharedQuota: q({ exhausted: true, remaining: 0 }) }), false)).toEqual({ gate: 'ask-key', code: 'shared_quota_exhausted' });
    // remaining 0 without `exhausted` = slots reserved by requests in flight: let the server decide.
    expect(detectionCheck(health({ sharedQuota: q({ remaining: 0 }) }), false)).toEqual({ gate: 'ok', code: null });
    expect(detectionCheck(health({ apiKeyConfigured: false, sharedQuota: q({ enabled: false, remaining: null, cap: null, resetsAt: null }) }), false)).toEqual({ gate: 'ask-key', code: 'shared_key_unavailable' });
    // A server without the sharedQuota block, and no shared key.
    expect(detectionCheck(health({ apiKeyConfigured: false, sharedQuota: null }), false)).toEqual({ gate: 'ask-key', code: 'shared_key_unavailable' });
  });

  it('reports an unreachable server (a key would not help)', () => {
    expect(detectionGate(null, false)).toBe('server-down');
    expect(detectionGate(null, true)).toBe('server-down');
    expect(detectionGate(health(), false, err('network'))).toBe('server-down');
    expect(detectionGate(health(), true, err('api_unavailable'))).toBe('server-down');
  });

  it('goes manual when the server cannot run Roboflow at all', () => {
    expect(detectionCheck(health({ byok: { available: false } }), true)).toEqual({ gate: 'manual', code: 'provider_not_installed' });
    expect(detectionGate(health(), true, err('provider_not_installed'))).toBe('manual');
    expect(detectionGate(health(), false, err('too_large'))).toBe('manual');
    expect(detectionGate(health(), false, err('invalid_image'))).toBe('manual');
  });

  it('asks for a key for every error a key fixes', () => {
    for (const c of ['shared_quota_exhausted', 'shared_rate_limited', 'shared_key_unavailable', 'user_key_invalid', 'user_key_format', 'user_key_forbidden', 'user_key_no_credits', 'user_billing_paused'])
      expect(detectionCheck(health(), true, err(c))).toEqual({ gate: 'ask-key', code: c });
  });

  it('maps the missing_api_key alias by whether the user has a key', () => {
    expect(detectionCheck(health(), false, err('missing_api_key'))).toEqual({ gate: 'ask-key', code: 'shared_key_unavailable' });
    expect(detectionCheck(health(), true, err('missing_api_key'))).toEqual({ gate: 'ask-key', code: 'user_key_invalid' });
  });

  it('offers a retry for transient failures', () => {
    for (const c of ['provider_rate_limited', 'inference_timeout', 'provider_error', 'model_unavailable', 'bad_response', 'something_new']) expect(detectionGate(health(), false, err(c))).toBe('retry');
  });

  it('an error wins over a healthy server', () => {
    expect(detectionGate(health(), false, err('shared_rate_limited'))).toBe('ask-key');
  });
});

describe('askForKey', () => {
  it('opens the required dialog with a prompt and the notice; saving a key clears the prompt', () => {
    const onManual = () => {};
    askForKey('shared_key_unavailable', { autoRetry: true, onManual });
    const s = useStore.getState();
    expect(s.keyDialogOpen).toBe(true);
    expect(s.notice?.action).toBe('roboflow-key');
    expect(getKeyPrompt()).toMatchObject({ reason: 'shared_key_unavailable', autoRetry: true, onManual });
    // The prompt holds no key, and the store never does.
    expect(JSON.stringify(useStore.getState())).not.toContain(KEY);
    setRoboflowKey(KEY, false);
    expect(getKeyPrompt()).toBeNull();
  });

  it('keeps autoRetry / onManual from an existing prompt (analyzePhoto re-asks without them)', () => {
    const onManual = () => {};
    setKeyPrompt({ reason: 'shared_quota_exhausted', autoRetry: true, onManual });
    askForKey('shared_rate_limited', { notice: false });
    expect(getKeyPrompt()).toMatchObject({ reason: 'shared_rate_limited', autoRetry: true, onManual });
    expect(useStore.getState().notice).toBeNull();
    setKeyPrompt(null);
  });

  it('a key error from /api/analyze sets the prompt with the reset date', async () => {
    setKeyPrompt(null);
    mockApi(() => json(402, { detail: { code: 'shared_quota_exhausted', message: 'used up', resetsAt: '2026-12-01T00:00:00Z' } }));
    await analyzeError(analyzePhoto(photo()));
    expect(getKeyPrompt()).toMatchObject({ reason: 'shared_quota_exhausted', resetsAt: '2026-12-01T00:00:00Z' });
    setKeyPrompt(null);
  });
});

describe('VITE_API_BASE_URL', () => {
  // The base URL is read once at module load, so each case stubs the env and imports a fresh module.
  async function freshApi(base: string | undefined) {
    vi.stubEnv('VITE_API_BASE_URL', base);
    vi.resetModules();
    return import('../analyzeApi');
  }
  const urlsOf = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(([u]) => String(u));
  const stubFetch = () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).includes('/api/health') ? json(200, HEALTH) : json(200, ANALYSIS)));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prefixes /api/health and /api/analyze with the configured origin (trailing slash trimmed)', async () => {
    const api = await freshApi(' https://api.example.com/ ');
    expect(api.API_BASE_URL).toBe('https://api.example.com');
    const fn = stubFetch();
    await api.analyzePhoto(photo(), { provider: 'hosted', depth: false });
    await settle();
    expect(urlsOf(fn)).toContain('https://api.example.com/api/analyze?provider=hosted&depth=false');
    expect(urlsOf(fn)).toContain('https://api.example.com/api/health');
  });

  it('keeps requests relative when unset or empty', async () => {
    for (const base of [undefined, '']) {
      const api = await freshApi(base);
      expect(api.API_BASE_URL).toBe('');
      const fn = stubFetch();
      await api.analyzePhoto(photo(), { provider: 'hosted', depth: false });
      await settle();
      expect(urlsOf(fn).sort()).toEqual(['/api/analyze?provider=hosted&depth=false', '/api/health']);
    }
  });
});
