import { describe, expect, it } from 'vitest';
import { anyHit, buildObstacleIndex, castRay } from '../raycast';
import { rect, scene } from './helpers';
import type { BoxObstacle, TreeObstacle } from '../types';

describe('ray casting', () => {
  const idx = buildObstacleIndex(
    scene([
      { id: 'a', kind: 'building', label: 'A', ring: rect(10, -5, 20, 5), zMin: 0, zMax: 10 },
      { id: 'b', kind: 'building', label: 'B', ring: rect(30, -5, 40, 5), zMin: 0, zMax: 30 },
      // L-shaped (concave) footprint
      { id: 'L', kind: 'building', label: 'L', ring: [[-40, -40], [-20, -40], [-20, -30], [-30, -30], [-30, -20], [-40, -20]], zMin: 0, zMax: 12 },
    ]),
  );

  it('hits the nearest prism wall', () => {
    const h = castRay(idx, [0, 0, 5], [1, 0, 0]);
    expect(h.hit).toBe(true);
    expect(h.id).toBe('a');
    expect(h.t).toBeCloseTo(10, 9);
  });
  it('passes over a low building and hits the taller one', () => {
    const h = castRay(idx, [0, 0, 15], [1, 0, 0]);
    expect(h.id).toBe('b');
    expect(h.t).toBeCloseTo(30, 9);
  });
  it('hits roof caps from above / misses when rising over', () => {
    const down = castRay(idx, [15, 0, 50], [0, 0, -1]);
    expect(down.id).toBe('a');
    expect(down.t).toBeCloseTo(40, 9);
    const steep = anyHit(idx, [0, 0, 5], [1, 0, 1]); // 45° up: at x=10 z=15 > 10, at x=30 z=35 > 30
    expect(steep.hit).toBe(false);
  });
  it('respects concave footprints', () => {
    // Ray through the notch of the L (x=-25,y=-25 is outside the L) must not hit.
    expect(anyHit(idx, [-25, -25, 5], [0, 1, 0]).hit).toBe(false);
    expect(anyHit(idx, [-25, -25, 5], [-1, 0, 0]).id).toBe('L');
  });
  it('ignores the own building only near the start', () => {
    const own = buildObstacleIndex(scene([{ id: 'own', kind: 'target-building', label: 'own', ring: rect(0, 0, 10, 10), zMin: 0, zMax: 10 }]));
    expect(anyHit(own, [5, -0.02, 5], [0, -1, 0.5], { ignoreId: 'own' }).hit).toBe(false); // leaves its wall
    expect(anyHit(own, [5, 0, 5], [0.3, -1, 0.2], { ignoreId: 'own' }).hit).toBe(false); // starts exactly on the wall
    expect(anyHit(own, [5, -0.02, 5], [0, 1, 0], { ignoreId: 'own' }).hit).toBe(true); // pointing into itself: blocked by the far wall
    expect(anyHit(own, [5, -5, 5], [0, 1, 0], { ignoreId: 'own' }).hit).toBe(true); // far away: still solid
  });
  it('intersects oriented boxes and trees', () => {
    const box: BoxObstacle = {
      id: 'box', kind: 'balcony', label: 'Balcony', center: [0, 5, 3],
      axes: [[Math.SQRT1_2, Math.SQRT1_2, 0], [-Math.SQRT1_2, Math.SQRT1_2, 0], [0, 0, 1]], halfSize: [1, 1, 0.1],
    };
    const tree: TreeObstacle = { id: 'tree', kind: 'tree', label: 'Tree', position: [0, 20], height: 10, crownRadius: 3, trunkRadius: 0.3 };
    const i2 = buildObstacleIndex(scene([], { boxes: [box], trees: [tree] }));
    expect(castRay(i2, [0, 0, 3], [0, 1, 0]).id).toBe('box');
    expect(castRay(i2, [0, 0, 3], [0, 1, 0]).t).toBeCloseTo(5 - Math.SQRT2, 6);
    expect(castRay(i2, [0, 0, 7], [0, 1, 0]).id).toBe('tree'); // crown centre at z=7
    expect(castRay(i2, [0, 0, 7], [0, 1, 0]).t).toBeCloseTo(17, 6);
    expect(castRay(i2, [0, 0, 2], [0, 1, 0]).id).toBe('tree'); // trunk
    expect(castRay(i2, [0, 0, 2], [0, 1, 0]).t).toBeCloseTo(19.7, 6);
    expect(anyHit(i2, [5, 0, 7], [0, 1, 0]).hit).toBe(false);
  });
  it('works with an empty scene', () => {
    expect(anyHit(buildObstacleIndex(scene([])), [0, 0, 0], [0, 0, 1]).hit).toBe(false);
  });
});
