/**
 * "Which side of the building is in your photo?" (direction picker, side-panel half).
 *
 * The map half is FacadeArrows (one arrow per facade, on the map). Here: the same sides as
 * chips (keyboard, and the blank-canvas fallback when tiles fail), the chosen direction in
 * words, "Flip to the opposite side", and ±5° fine heading. The camera dot on the map stays
 * draggable. Every camera here comes from lib/tileBuildings.ts; nothing is invented: the
 * stand-off is labelled assumed, a turned heading manual.
 */
import { useId, useMemo } from 'react';
import clsx from 'clsx';
import { Dot } from '../kit';
import { SIDE_CHIPS_MAX, cameraForSide, compassPoint, compassWord, currentSide, describeDirection, facadeSides, oppositeSide, turnCamera, type CameraPlacement, type FacadeSide } from '../../lib/tileBuildings';
import type { PickResult } from './BuildingPicker';
import type { LatLon } from '../../schema/scene';
import { lonLatToEnu } from '../../engine/geo';

export const DIRECTION_COPY = {
  title: 'Which side of the building is in your photo?',
  hint: 'Tap the arrow on the map that points at the side you photographed, or pick it here.',
  flip: 'Flip to the opposite side',
  oblique: "Your photo looks along the street: when the model is built, the camera turns to look along this side from the photo's perspective (the window rows' vanishing point), if that explains the windows better.",
} as const;

const chip = 'inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium ring-1 ring-inset transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:min-w-11';
const btn = 'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11';
/** ±5° as one grey well, like a number stepper. */
const nudge = 'inline-flex h-7 items-center justify-center rounded-md px-2 text-xs font-medium text-ink-200 hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:min-w-11';

export default function DirectionControls({
  sel,
  onCamera,
  disabled,
  gps,
  oblique,
}: {
  sel: PickResult;
  onCamera: (c: CameraPlacement) => void;
  disabled?: boolean;
  gps?: LatLon;
  /** The photo is an oblique street view (lib/vanishing streetPerspective): the build re-aims the camera along the side. */
  oblique?: boolean;
}) {
  const titleId = useId();
  const target = sel.footprints.find((f) => f.id === sel.targetId) ?? null;
  const sides = useMemo<FacadeSide[]>(() => (target ? facadeSides(target, { max: SIDE_CHIPS_MAX }) : []), [target]);
  const side = target ? currentSide(target, sides, sel.camera) : null;
  const opposite = side ? oppositeSide(sides, side) : null;
  if (!target || !sides.length) return null;

  const pick = (s: FacadeSide) => {
    // The photo's GPS point is kept when it stands in front of the picked side (cameraForSide).
    onCamera(cameraForSide(s, sel.footprints, { targetId: sel.targetId, gps: gps ? lonLatToEnu(sel.origin, gps) : undefined }));
  };
  // Duplicate labels (e.g. two east-facing wings) get their length to tell them apart.
  const dup = new Set(sides.map((s) => s.label).filter((l, i, a) => a.indexOf(l) !== i));
  const h = sel.camera.heading;

  return (
    <section aria-labelledby={titleId} className="space-y-2 border-b border-ink-700 px-4 py-3">
      <h2 id={titleId} className="text-[13px] font-semibold leading-5 text-paper">
        {DIRECTION_COPY.title}
      </h2>
      <p className="text-xs leading-4 text-ink-300">{DIRECTION_COPY.hint}</p>
      <div role="group" aria-label="Facades" className="flex flex-wrap gap-1 pt-1">
        {sides.map((s) => {
          const on = side?.edge === s.edge;
          return (
            <button
              key={s.edge}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              aria-label={`${compassWord(s.faces)} facade, ${Math.round(s.length)} m`}
              onClick={() => pick(s)}
              className={clsx(chip, on ? 'bg-selected text-paper ring-accent' : 'text-ink-200 ring-ink-700 hover:bg-ink-800 hover:text-paper')}
            >
              {s.label}
              {dup.has(s.label) && <span className={clsx('num font-normal', on ? 'text-ink-200' : 'text-ink-400')}>{Math.round(s.length)} m</span>}
            </button>
          );
        })}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-paper" aria-live="polite">
        <span className="font-medium">{describeDirection(h, side)}</span>
        <span className="text-[11px] text-ink-400">
          Heading <span className="num">{Math.round(h)}°</span> {compassPoint(h)}
        </span>
        <Dot p={sel.camera.provenance.heading} />
      </p>
      {oblique && sel.camera.provenance.heading !== 'manual' && sel.camera.provenance.heading !== 'observed' && <p className="text-[11px] leading-4 text-ink-400">{DIRECTION_COPY.oblique}</p>}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button type="button" className={btn} disabled={disabled || !opposite} onClick={() => opposite && pick(opposite)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-300">
            <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
          </svg>
          {DIRECTION_COPY.flip}
        </button>
        <span className="ml-auto inline-flex items-center rounded-md bg-ink-800" role="group" aria-label="Fine-tune the viewing direction">
          <button type="button" className={nudge} disabled={disabled} aria-label="Turn 5° to the left" onClick={() => onCamera(turnCamera(sel.camera, -5))}>
            <span className="num">−5°</span>
          </button>
          <span aria-hidden className="h-4 w-px bg-ink-600" />
          <button type="button" className={nudge} disabled={disabled} aria-label="Turn 5° to the right" onClick={() => onCamera(turnCamera(sel.camera, 5))}>
            <span className="num">+5°</span>
          </button>
        </span>
      </div>
    </section>
  );
}
