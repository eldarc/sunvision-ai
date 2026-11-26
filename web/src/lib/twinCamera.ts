/**
 * Where the 3D view's camera goes for each view mode (ENU metres). Pure, so it is testable
 * without three.js; components/TwinView.tsx animates the camera to the pose it returns.
 */
import type { ViewMode } from '../state/store';
import type { Vec3 } from '../schema/scene';

export interface StreetCam {
  eye: Vec3;
  dir: Vec3;
}
export interface ApartmentCams {
  eye: Vec3;
  target: Vec3;
  interior: { eye: Vec3; target: Vec3 };
}
export interface CameraPose {
  eye: Vec3;
  target: Vec3;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const finVec = (v: readonly unknown[]): v is Vec3 => v.length >= 2 && v.every(fin);

/** The Apartment and Inside views look at the selected apartment, so they need one. */
export const needsApartment = (mode: ViewMode) => mode === 'exterior' || mode === 'interior';

/**
 * The view to switch to when the current one cannot be shown, else null. An apartment view without an
 * apartment goes back to the street. `ready` is false while the reconstruction is still being built:
 * there is no apartment yet then, and switching away would undo a pending pick.
 */
export function fallbackView(mode: ViewMode, hasApartment: boolean, ready: boolean): ViewMode | null {
  return ready && !hasApartment && needsApartment(mode) ? 'street' : null;
}

/**
 * The camera pose for `mode`, or null when the camera should stay where it is: an apartment view
 * with no apartment (nothing selected, or degenerate geometry), or a non-finite pose (NaN in the
 * camera matrix blanks the canvas). Never falls back to another view's pose: jumping to the
 * overview when "Inside" has nothing to look inside reads as a zoom-out for no reason.
 */
export function cameraPose(mode: ViewMode, focus: Vec3, street: StreetCam, apt: ApartmentCams | null): CameraPose | null {
  let pose: CameraPose;
  if (mode === 'top') pose = { eye: [focus[0], focus[1] - 0.01, 260], target: focus };
  else if (mode === 'street') {
    const { eye, dir } = street;
    pose = { eye, target: [eye[0] + dir[0] * 30, eye[1] + dir[1] * 30, eye[2] + dir[2] * 30] };
  } else if (needsApartment(mode)) {
    if (!apt) return null;
    pose = mode === 'exterior' ? { eye: apt.eye, target: apt.target } : { eye: apt.interior.eye, target: apt.interior.target };
  } else pose = { eye: [focus[0] - 110, focus[1] - 140, 120], target: focus };
  return finVec(pose.eye) && finVec(pose.target) ? pose : null;
}
