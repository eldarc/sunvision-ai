/**
 * The oblique-street re-start (lib/vanishing.ts) must leave the curated examples alone: their
 * cameras already explain their window rows. Runs on the published example data and on the
 * Vilsonovo šetalište test fixture (fixtures/vilsonovo/README.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FacadeAnalysis, Scene } from '../../schema/scene';
import { obliqueStart, streetPerspective } from '../vanishing';

const EXAMPLE_DIRS: [string, string][] = [
  ...['amsterdam-herengracht', 'paris-boulevard-diderot', 'nyc-ridge-street', 'sarajevo-obala-kulina-bana'].map((ex): [string, string] => [ex, resolve(__dirname, '../../../public/examples', ex)]),
  ['vilsonovo (fixture)', resolve(__dirname, 'fixtures/vilsonovo')],
];

describe('curated examples and the oblique-street re-start', () => {
  it('keep their cameras', () => {
    // Amsterdam and Paris are frontal (no street vanishing point); NYC looks ≈ 52° off its facade's
    // normal and sits at the edge of the gate (rms ≈ 6.1° vs 6°), but its own camera already explains
    // its rows, so it is never re-initialised. Sarajevo (Obala Kulina bana 24) is frontal too. The
    // Vilsonovo šetalište fixture looks ≈ 27° off its facade's normal: its rows converge far
    // outside the frame (x ≈ 6500 px), not a street view, and its heading is observed anyway.
    for (const [ex, dir] of EXAMPLE_DIRS) {
      const a = JSON.parse(readFileSync(resolve(dir, 'analysis.json'), 'utf8')) as FacadeAnalysis;
      const sc = JSON.parse(readFileSync(resolve(dir, 'scene.base.json'), 'utf8')) as Scene;
      if (ex !== 'nyc-ridge-street') expect(streetPerspective(a.detections, { width: a.imageWidth, height: a.imageHeight }), ex).toBeNull();
      expect(obliqueStart({ ...sc, analysis: a }, sc.camera, a.detections).applied, ex).toBe(false);
    }
  });
});
