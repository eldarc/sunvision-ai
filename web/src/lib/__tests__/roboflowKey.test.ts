import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROBOFLOW_KEY_STORAGE,
  ROBOFLOW_VALIDATE_URL,
  checkKey,
  clearRoboflowKey,
  getRoboflowKey,
  hasRoboflowKey,
  isRoboflowKeyRemembered,
  keyHeaders,
  looksPublishable,
  setRoboflowKey,
  subscribeRoboflowKey,
  validateRoboflowKey,
} from '../roboflowKey';

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

class ThrowingStorage implements Storage {
  get length(): number {
    throw new Error('SecurityError');
  }
  clear(): void {
    throw new Error('SecurityError');
  }
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  key(): string | null {
    throw new Error('SecurityError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('SecurityError');
  }
}

// A deliberately fake key; never a real one.
const KEY = 'TESTKEY0000fake0000';

let session: MemStorage;
let local: MemStorage;

beforeEach(() => {
  session = new MemStorage();
  local = new MemStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('roboflowKey storage', () => {
  it('stores in sessionStorage only by default (remember off)', () => {
    setRoboflowKey(`  ${KEY}  `, false);
    expect(session.getItem(ROBOFLOW_KEY_STORAGE)).toBe(KEY);
    expect(local.getItem(ROBOFLOW_KEY_STORAGE)).toBeNull();
    expect(getRoboflowKey()).toBe(KEY);
    expect(hasRoboflowKey()).toBe(true);
    expect(isRoboflowKeyRemembered()).toBe(false);
  });

  it('stores in localStorage only with "Remember on this device", clearing the session copy', () => {
    setRoboflowKey(KEY, false);
    setRoboflowKey(KEY, true);
    expect(local.getItem(ROBOFLOW_KEY_STORAGE)).toBe(KEY);
    expect(session.getItem(ROBOFLOW_KEY_STORAGE)).toBeNull();
    expect(isRoboflowKeyRemembered()).toBe(true);
    // And back again.
    setRoboflowKey(KEY, false);
    expect(local.getItem(ROBOFLOW_KEY_STORAGE)).toBeNull();
    expect(session.getItem(ROBOFLOW_KEY_STORAGE)).toBe(KEY);
  });

  it('prefers sessionStorage over localStorage when both hold a value', () => {
    local.setItem(ROBOFLOW_KEY_STORAGE, 'LOCALKEY');
    session.setItem(ROBOFLOW_KEY_STORAGE, 'SESSIONKEY');
    expect(getRoboflowKey()).toBe('SESSIONKEY');
  });

  it('clearRoboflowKey removes both copies and keyHeaders() becomes empty', () => {
    local.setItem(ROBOFLOW_KEY_STORAGE, 'LOCALKEY');
    session.setItem(ROBOFLOW_KEY_STORAGE, 'SESSIONKEY');
    expect(keyHeaders()).toEqual({ 'X-Roboflow-Key': 'SESSIONKEY' });
    clearRoboflowKey();
    expect(session.getItem(ROBOFLOW_KEY_STORAGE)).toBeNull();
    expect(local.getItem(ROBOFLOW_KEY_STORAGE)).toBeNull();
    expect(getRoboflowKey()).toBeNull();
    expect(keyHeaders()).toEqual({});
  });

  it('an empty or whitespace key clears instead of saving', () => {
    setRoboflowKey(KEY, true);
    setRoboflowKey('   ', true);
    expect(hasRoboflowKey()).toBe(false);
  });

  it('swallows storage exceptions (private mode, blocked site data)', () => {
    vi.stubGlobal('sessionStorage', new ThrowingStorage());
    vi.stubGlobal('localStorage', new ThrowingStorage());
    expect(() => setRoboflowKey(KEY, false)).not.toThrow();
    expect(() => setRoboflowKey(KEY, true)).not.toThrow();
    expect(() => clearRoboflowKey()).not.toThrow();
    expect(getRoboflowKey()).toBeNull();
    expect(keyHeaders()).toEqual({});
  });

  it('works when storage globals are missing entirely', () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(() => setRoboflowKey(KEY, false)).not.toThrow();
    expect(getRoboflowKey()).toBeNull();
  });

  it('notifies subscribers without passing the key', () => {
    const cb = vi.fn();
    const off = subscribeRoboflowKey(cb);
    setRoboflowKey(KEY, false);
    clearRoboflowKey();
    off();
    setRoboflowKey(KEY, false);
    expect(cb).toHaveBeenCalledTimes(2);
    for (const call of cb.mock.calls) expect(call).toEqual([]);
  });

  it('never logs the key', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    setRoboflowKey(KEY, true);
    getRoboflowKey();
    keyHeaders();
    clearRoboflowKey();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('publishable rf_ keys', () => {
  it('detects rf_ keys', () => {
    expect(looksPublishable('rf_abc')).toBe(true);
    expect(looksPublishable('  rf_abc ')).toBe(true);
    expect(looksPublishable(KEY)).toBe(false);
  });

  it('returns the publishable warning without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await validateRoboflowKey('rf_abc')).toEqual({ ok: false, reason: 'publishable' });
    expect(await checkKey('rf_abc')).toEqual({ ok: false, reason: 'publishable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('validateRoboflowKey', () => {
  it('sends GET https://api.roboflow.com/ with a Bearer header and no key in the URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ welcome: 'Welcome to the Roboflow API.', workspace: 'my-ws' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await validateRoboflowKey(`  ${KEY} `);
    expect(r).toEqual({ ok: true, workspace: 'my-ws' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ROBOFLOW_VALIDATE_URL);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('a 200 without a workspace field is still ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await validateRoboflowKey(KEY)).toEqual({ ok: true });
    expect(await checkKey(KEY)).toEqual({ ok: true, workspace: null });
  });

  it('maps 401 OAuthException to invalid', async () => {
    const body = { error: { message: 'This API key does not exist (or has been revoked).', status: 401, type: 'OAuthException' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 401 })));
    expect(await validateRoboflowKey(KEY)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('maps a fetch failure or a 5xx to network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    expect(await validateRoboflowKey(KEY)).toEqual({ ok: false, reason: 'network' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })));
    expect(await validateRoboflowKey(KEY)).toEqual({ ok: false, reason: 'network' });
  });

  it('rejects malformed keys without calling Roboflow', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await validateRoboflowKey('two words')).toEqual({ ok: false, reason: 'format' });
    expect(await validateRoboflowKey('x'.repeat(129))).toEqual({ ok: false, reason: 'format' });
    expect(await validateRoboflowKey('')).toEqual({ ok: false, reason: 'empty' });
    expect(await checkKey('two words')).toEqual({ ok: false, reason: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rethrows when aborted', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    }));
    await expect(validateRoboflowKey(KEY, ac.signal)).rejects.toThrow('aborted');
  });
});
