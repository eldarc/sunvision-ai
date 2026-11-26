/**
 * Direction picker on the map: one round button per facade of the picked building, placed just
 * outside the facade and pointing at it, labelled with the compass direction the facade faces.
 * Tapping one tells the flow "my photo shows this side" (the camera is placed across from it).
 *
 * Buttons are React elements over the map canvas, positioned with `map.project` and updated on
 * every map move (rAF-throttled), so they keep their size at any zoom and rotation (36 px, 44 px
 * under a coarse pointer).
 */
import { useEffect, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import clsx from 'clsx';
import type { LatLon } from '../../schema/scene';
import { enuToLonLat } from '../../engine/geo';
import { compassWord, type FacadeSide } from '../../lib/tileBuildings';

/** Distance of the button centre from the facade midpoint, in screen px. */
const OFFSET_PX = 34;

interface Placed {
  side: FacadeSide;
  x: number;
  y: number;
  /** Screen angle (deg, clockwise from "up") the chevron points: towards the facade. */
  rot: number;
}

export default function FacadeArrows({ map, origin, sides, selectedEdge, onPick }: { map: maplibregl.Map; origin: LatLon; sides: FacadeSide[]; selectedEdge: number | null; onPick: (s: FacadeSide) => void }) {
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const out: Placed[] = [];
      for (const s of sides) {
        const m = enuToLonLat(origin, s.mid);
        const o = enuToLonLat(origin, [s.mid[0] + s.normal[0] * 2, s.mid[1] + s.normal[1] * 2]);
        const p0 = map.project([m.lon, m.lat]);
        const p1 = map.project([o.lon, o.lat]);
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        // The chevron points back at the facade: direction (−dx, −dy) on screen.
        const rot = (Math.atan2(-dx, dy) * 180) / Math.PI;
        out.push({ side: s, x: p0.x + dx * OFFSET_PX, y: p0.y + dy * OFFSET_PX, rot });
      }
      // Overlapping buttons (short sides at a notch, or zoomed out): keep the longer side's
      // arrow; every side is still in the panel's chips.
      const kept: Placed[] = [];
      for (const p of [...out].sort((a, b) => b.side.length - a.side.length)) {
        if (kept.every((k) => Math.hypot(k.x - p.x, k.y - p.y) >= 46)) kept.push(p);
      }
      setPlaced(kept);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    map.on('move', schedule);
    map.on('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      map.off('move', schedule);
      map.off('resize', schedule);
    };
  }, [map, origin, sides]);

  const el = map.getContainer();
  const w = el.clientWidth;
  const h = el.clientHeight;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" role="group" aria-label="Which side of the building is in your photo?">
      {placed.map(({ side, x, y, rot }) => {
        if (x < -22 || y < -22 || x > w + 22 || y > h + 22) return null;
        const on = side.edge === selectedEdge;
        const word = compassWord(side.faces);
        return (
          <button
            key={side.edge}
            type="button"
            aria-pressed={on}
            aria-label={`My photo shows the ${word} facade (${Math.round(side.length)} m)`}
            title={`Photo of the ${word} facade`}
            onClick={() => onPick(side)}
            className={clsx(
              'pointer-events-auto absolute grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[11px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11',
              on ? 'bg-accent text-on-accent shadow-float ring-2 ring-knob' : 'bg-ink-900 text-paper shadow-float hover:bg-ink-800 hover:ring-1 hover:ring-accent',
            )}
            style={{ left: x, top: y }}
          >
            {/* Chevron on the rim, pointing at the facade */}
            <span aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: `rotate(${rot}deg)` }}>
              <svg viewBox="0 0 44 44" className="h-full w-full">
                <path d="M16 6 L22 0.5 L28 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span aria-hidden className="relative leading-none">
              {side.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
