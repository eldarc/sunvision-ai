/**
 * Background annual sunlight computation (Vite module worker).
 * In:  { key, obstacles, windows, ctx, options }
 * Out: { type: 'progress', key, done, total } | { type: 'result', key, result } | { type: 'error', key, message }
 */
import { buildObstacleIndex } from './raycast';
import { annualExposure, type AnnualOptions } from './exposure';
import type { ObstacleScene, WindowSpec } from './types';
import type { SolarContext } from './solar';

export interface AnnualWorkerRequest {
  key: string;
  obstacles: ObstacleScene;
  windows: WindowSpec[];
  ctx: SolarContext;
  options: AnnualOptions;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (ev: MessageEvent<AnnualWorkerRequest>) => {
  const { key, obstacles, windows, ctx, options } = ev.data;
  try {
    const index = buildObstacleIndex(obstacles);
    const result = annualExposure(index, windows, ctx, options, (done, total) => {
      scope.postMessage({ type: 'progress', key, done, total });
    });
    scope.postMessage({ type: 'result', key, result });
  } catch (e) {
    scope.postMessage({ type: 'error', key, message: e instanceof Error ? e.message : String(e) });
  }
};
