import { describe, expect, it } from 'vitest';
import { bearingOf, bearingVector, enuToLonLat, lonLatToEnu, lonLatToEnu3 } from '../geo';

describe('WGS84 ENU conversion', () => {
  // Reference values computed with pyproj (EPSG:4979 -> EPSG:4978) + explicit ENU rotation.
  it('matches pyproj reference (Amsterdam)', () => {
    const e = lonLatToEnu3({ lat: 52.3731, lon: 4.8926 }, { lat: 52.375, lon: 4.896 });
    expect(e[0]).toBeCloseTo(231.5490816914243, 6);
    expect(e[1]).toBeCloseTo(211.42689419361807, 6);
    expect(e[2]).toBeCloseTo(-0.007699874462019807, 6);
  });
  it('matches pyproj reference (New York)', () => {
    const e = lonLatToEnu({ lat: 40.7484, lon: -73.9857 }, { lat: 40.7466, lon: -73.989 });
    expect(e[0]).toBeCloseTo(-278.7067251041035, 6);
    expect(e[1]).toBeCloseTo(-199.88301579738527, 6);
  });
  it('round-trips', () => {
    const o = { lat: 48.8566, lon: 2.3522 };
    for (const p of [
      { lat: 48.8577, lon: 2.3541 },
      { lat: 48.8549, lon: 2.3499 },
      { lat: 48.8566, lon: 2.3522 },
    ]) {
      const xy = lonLatToEnu(o, p);
      const back = enuToLonLat(o, xy);
      expect(back.lat).toBeCloseTo(p.lat, 9);
      expect(back.lon).toBeCloseTo(p.lon, 9);
    }
    expect(lonLatToEnu(o, o)[0]).toBeCloseTo(0, 9);
  });
  it('converts compass bearings', () => {
    expect(bearingOf(0, 1)).toBeCloseTo(0);
    expect(bearingOf(1, 0)).toBeCloseTo(90);
    expect(bearingOf(0, -1)).toBeCloseTo(180);
    expect(bearingOf(-1, 0)).toBeCloseTo(270);
    const v = bearingVector(135);
    expect(v[0]).toBeCloseTo(Math.SQRT1_2);
    expect(v[1]).toBeCloseTo(-Math.SQRT1_2);
  });
});
