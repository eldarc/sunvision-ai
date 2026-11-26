import { describe, expect, it } from 'vitest';
import { getPosition } from 'suncalc';
import { daySamples, localToUtc, sunDirENU, sunPosition, sunTimes, utcToLocal } from '../solar';
import { AMS, noaaSun } from './helpers';

describe('SunCalc 2.x conventions', () => {
  it('returns azimuth in degrees clockwise from north (raw library output)', () => {
    const st = sunTimes('2024-06-21', AMS.lat, AMS.lon, AMS.tz);
    const p = getPosition(new Date(st.solarNoon.utc), AMS.lat, AMS.lon);
    expect(p.azimuth).toBeGreaterThan(179);
    expect(p.azimuth).toBeLessThan(181);
    // ≈ 90 - 52.37 + 23.44
    expect(p.altitude).toBeGreaterThan(60.5);
    expect(p.altitude).toBeLessThan(61.6);
    const morning = getPosition(new Date('2024-06-21T05:00:00Z'), AMS.lat, AMS.lon);
    expect(morning.azimuth).toBeGreaterThan(45);
    expect(morning.azimuth).toBeLessThan(110); // east-north-east
    const evening = getPosition(new Date('2024-06-21T18:00:00Z'), AMS.lat, AMS.lon);
    expect(evening.azimuth).toBeGreaterThan(250); // west-north-west
  });

  it('agrees with an independent NOAA implementation', () => {
    const cases: [string, number, number][] = [
      ['2024-06-21T11:40:00Z', 52.3731, 4.8926],
      ['2024-12-21T11:45:00Z', 52.3731, 4.8926],
      ['2024-03-20T08:00:00Z', 48.8566, 2.3522],
      ['2024-09-22T17:00:00Z', 40.7484, -73.9857],
      ['2024-07-01T14:30:00Z', 41.3874, 2.1686],
      ['2024-01-15T09:00:00Z', 43.8563, 18.4131],
    ];
    for (const [iso, lat, lon] of cases) {
      const d = new Date(iso);
      const a = sunPosition(d, lat, lon);
      const b = noaaSun(d, lat, lon);
      expect(b.altitude).toBeGreaterThan(3);
      expect(Math.abs(a.altitude - b.altitude)).toBeLessThan(0.35); // refraction differs slightly
      const dAz = Math.abs(((a.azimuth - b.azimuth + 540) % 360) - 180);
      expect(dAz).toBeLessThan(0.3);
    }
  });

  it('converts azimuth/altitude into ENU unit vectors', () => {
    const e = sunDirENU(90, 0);
    expect(e[0]).toBeCloseTo(1, 9);
    expect(e[1]).toBeCloseTo(0, 9);
    const s = sunDirENU(180, 0);
    expect(s[1]).toBeCloseTo(-1, 9);
    const up = sunDirENU(0, 90);
    expect(up[2]).toBeCloseTo(1, 9);
    const v = sunDirENU(225, 30);
    expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect(v[0]).toBeLessThan(0);
    expect(v[1]).toBeLessThan(0);
  });
});

describe('timezone handling', () => {
  it('handles Amsterdam spring-forward (2024-03-31)', () => {
    expect(new Date(localToUtc('2024-03-31', 60, 'Europe/Amsterdam')).toISOString()).toBe('2024-03-31T00:00:00.000Z');
    expect(new Date(localToUtc('2024-03-31', 4 * 60, 'Europe/Amsterdam')).toISOString()).toBe('2024-03-31T02:00:00.000Z');
    expect(daySamples('2024-03-31', 'Europe/Amsterdam', AMS.lat, AMS.lon, 5)).toHaveLength(23 * 12);
  });
  it('handles Amsterdam fall-back (2024-10-27)', () => {
    expect(new Date(localToUtc('2024-10-27', 60, 'Europe/Amsterdam')).toISOString()).toBe('2024-10-26T23:00:00.000Z');
    expect(new Date(localToUtc('2024-10-27', 4 * 60, 'Europe/Amsterdam')).toISOString()).toBe('2024-10-27T03:00:00.000Z');
    expect(daySamples('2024-10-27', 'Europe/Amsterdam', AMS.lat, AMS.lon, 5)).toHaveLength(25 * 12);
    expect(daySamples('2024-10-28', 'Europe/Amsterdam', AMS.lat, AMS.lon, 5)).toHaveLength(24 * 12);
  });
  it('handles New York DST (2024-03-10)', () => {
    expect(new Date(localToUtc('2024-03-10', 60, 'America/New_York')).toISOString()).toBe('2024-03-10T06:00:00.000Z');
    expect(new Date(localToUtc('2024-03-10', 4 * 60, 'America/New_York')).toISOString()).toBe('2024-03-10T08:00:00.000Z');
    const l = utcToLocal(Date.parse('2024-07-04T16:00:00Z'), 'America/New_York');
    expect(l.date).toBe('2024-07-04');
    expect(l.minutes).toBe(12 * 60);
    expect(l.offsetMinutes).toBe(-240);
  });
  it('round-trips local <-> UTC', () => {
    for (const tz of ['Europe/Paris', 'America/Los_Angeles', 'Europe/Sarajevo', 'Asia/Tokyo']) {
      const t = localToUtc('2024-08-15', 13 * 60 + 37, tz);
      const l = utcToLocal(t, tz);
      expect(l.date).toBe('2024-08-15');
      expect(l.minutes).toBe(13 * 60 + 37);
    }
  });
  it('reports sunrise / sunset in local time and polar cases', () => {
    const st = sunTimes('2024-06-21', AMS.lat, AMS.lon, AMS.tz);
    expect(st.sunrise!.localMinutes).toBeGreaterThan(5 * 60 + 10);
    expect(st.sunrise!.localMinutes).toBeLessThan(5 * 60 + 25);
    expect(st.sunset!.localMinutes).toBeGreaterThan(22 * 60);
    expect(st.sunset!.localMinutes).toBeLessThan(22 * 60 + 12);
    expect(st.solarNoon.localMinutes).toBeGreaterThan(13 * 60 + 35);
    expect(st.solarNoon.localMinutes).toBeLessThan(13 * 60 + 47);
    const polarDay = sunTimes('2024-06-21', 69.65, 18.96, 'Europe/Oslo');
    expect(polarDay.alwaysUp).toBe(true);
    expect(polarDay.dayLengthMinutes).toBe(1440);
    const polarNight = sunTimes('2024-12-21', 69.65, 18.96, 'Europe/Oslo');
    expect(polarNight.alwaysDown).toBe(true);
    expect(polarNight.dayLengthMinutes).toBe(0);
  });
});

describe('localToUtc robustness while scrubbing', () => {
  it('never throws for any fractional minute, including xx:59.99 and 24:00', async () => {
    const { localToUtc } = await import('../solar');
    for (const m of [402.9999, 402.995, 1439.9999, 1440, 0, -5, 59.9999, 719.99999]) {
      expect(() => localToUtc('2026-04-15', m, 'Europe/Amsterdam')).not.toThrow();
    }
    // continuity: 402.9999 min ≈ 06:43:00
    const a = localToUtc('2026-04-15', 402.9999, 'Europe/Amsterdam');
    const b = localToUtc('2026-04-15', 403, 'Europe/Amsterdam');
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1000);
    // NaN falls back to midnight instead of throwing
    expect(() => localToUtc('2026-04-15', Number.NaN, 'Europe/Amsterdam')).not.toThrow();
  });
});
