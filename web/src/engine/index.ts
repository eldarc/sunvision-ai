/**
 * Sunvision solar / obstruction engine — public API.
 */
export * from './geo';
export * from './solar';
export * from './raycast';
export * from './exposure';
export type * from './types';

import { buildObstacleIndex } from './raycast';
import { annualExposure, type AnnualOptions, type AnnualResult } from './exposure';
import type { ObstacleScene, WindowSpec } from './types';
import type { SolarContext } from './solar';

export interface AnnualInput {
  obstacles: ObstacleScene;
  windows: WindowSpec[];
  ctx: SolarContext;
  options?: AnnualOptions;
}

/** FNV-1a 32-bit hash of a JSON string (cache key). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function annualKey(input: AnnualInput): string {
  return hashString(JSON.stringify([input.obstacles, input.windows, input.ctx, input.options ?? {}]));
}

const cache = new Map<string, Promise<AnnualResult>>();
const MAX_CACHE = 24;
let worker: Worker | null = null;
const pending = new Map<string, { resolve: (r: AnnualResult) => void; reject: (e: Error) => void; onProgress?: (d: number, t: number) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('./annual.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; key: string; done?: number; total?: number; result?: AnnualResult; message?: string };
      const p = pending.get(msg.key);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.done ?? 0, msg.total ?? 0);
      else if (msg.type === 'result' && msg.result) {
        pending.delete(msg.key);
        p.resolve(msg.result);
      } else if (msg.type === 'error') {
        pending.delete(msg.key);
        p.reject(new Error(msg.message ?? 'Annual computation failed'));
      }
    };
    worker.onerror = (e) => {
      for (const [k, p] of pending) {
        p.reject(new Error(e.message || 'Worker error'));
        pending.delete(k);
      }
    };
  }
  return worker;
}

/**
 * Run the annual analysis in a Web Worker (falls back to the main thread when
 * workers are unavailable, e.g. in tests). Results are cached by input hash.
 */
export function runAnnualInWorker(input: AnnualInput, onProgress?: (done: number, total: number) => void): Promise<AnnualResult> {
  const key = annualKey(input);
  const hit = cache.get(key);
  if (hit) return hit;
  const w = getWorker();
  const promise: Promise<AnnualResult> = w
    ? new Promise<AnnualResult>((resolve, reject) => {
        pending.set(key, { resolve, reject, onProgress });
        w.postMessage({ key, obstacles: input.obstacles, windows: input.windows, ctx: input.ctx, options: input.options ?? {} });
      })
    : Promise.resolve().then(() => annualExposure(buildObstacleIndex(input.obstacles), input.windows, input.ctx, input.options ?? {}, onProgress));
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return promise;
}

export function clearAnnualCache(): void {
  cache.clear();
}
