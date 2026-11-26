import { describe, expect, it } from 'vitest';
import { cameraPose, fallbackView, needsApartment, type ApartmentCams, type StreetCam } from '../twinCamera';
import type { Vec3 } from '../../schema/scene';

const focus: Vec3 = [10, 20, 0];
const street: StreetCam = { eye: [0, -30, 1.6], dir: [0, 1, 0] };
const apt: ApartmentCams = {
  eye: [2, 26, 16],
  target: [10, 0, 10],
  interior: { eye: [10, -6, 11.6], target: [10, 0, 10.9] },
};

describe('cameraPose', () => {
  it('stays put for Inside and Apartment when there is no apartment (no zoom-out to the overview)', () => {
    expect(cameraPose('interior', focus, street, null)).toBeNull();
    expect(cameraPose('exterior', focus, street, null)).toBeNull();
  });

  it('goes into the room for Inside and outside it for Apartment', () => {
    expect(cameraPose('interior', focus, street, apt)).toEqual({ eye: apt.interior.eye, target: apt.interior.target });
    expect(cameraPose('exterior', focus, street, apt)).toEqual({ eye: apt.eye, target: apt.target });
  });

  it('looks 30 m along the photo direction from the photographer for Street', () => {
    expect(cameraPose('street', focus, street, null)).toEqual({ eye: street.eye, target: [0, 0, 1.6] });
  });

  it('frames the target building from above for Overview and Top, with or without an apartment', () => {
    expect(cameraPose('overview', focus, street, null)).toEqual({ eye: [-100, -120, 120], target: focus });
    expect(cameraPose('top', focus, street, apt)?.target).toEqual(focus);
  });

  it('refuses a non-finite pose rather than putting NaN in the camera matrix', () => {
    expect(cameraPose('street', focus, { eye: [NaN, 0, 1.6], dir: [0, 1, 0] }, null)).toBeNull();
    expect(cameraPose('interior', focus, street, { ...apt, interior: { eye: [Infinity, 0, 0], target: [0, 0, 0] } })).toBeNull();
  });
});

describe('needsApartment', () => {
  it('is true only for the apartment views', () => {
    expect(['overview', 'street', 'exterior', 'interior', 'top'].filter((m) => needsApartment(m as never))).toEqual(['exterior', 'interior']);
  });
});

describe('fallbackView', () => {
  it('leaves Apartment and Inside for the street once there is no apartment (even with windows still selected)', () => {
    expect(fallbackView('interior', false, true)).toBe('street');
    expect(fallbackView('exterior', false, true)).toBe('street');
  });

  it('keeps the view while the reconstruction is still being built, so a pending pick is not undone', () => {
    expect(fallbackView('exterior', false, false)).toBeNull();
  });

  it('keeps views that are fine as they are', () => {
    expect(fallbackView('interior', true, true)).toBeNull();
    for (const m of ['street', 'overview', 'top'] as const) expect(fallbackView(m, false, true)).toBeNull();
  });
});
