/**
 * Manual building outline for the upload flow ("Not on the map? Draw it", and the fallback when map tiles fail).
 *
 *  - `FootprintDraw` (default): the user clicks the building's 4 corners on the MapLibre map.
 *    Keyboard users pan the map (arrow keys) and add a corner at the centre crosshair.
 *  - `MetricCanvas`: used when the map tiles do not load. A blank `ink-900` grid in metres
 *    around a coordinate; the same 4-corner drawing, plus the draggable camera dot.
 *
 * The result is a `user/…` footprint with provenance `manual` (built by lib/tileBuildings.ts).
 * Colours follow the theme: map layers use upload/mapPalette.ts, the SVG canvas uses tokens.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type maplibregl from 'maplibre-gl';
import type { Feature } from 'geojson';
import type { LatLon, Vec2 } from '../../schema/scene';
import { useMapPalette } from './mapPalette';

export const DRAW_INSTRUCTION = "Tap or click the building's 4 corners.";
const CORNERS = 4;
const btn = 'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11';
/** Square 28 px icon button for a floating toolbar. */
const iconBtn = 'grid h-7 w-7 place-items-center rounded-md text-ink-200 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11';

/* ------------------------------------------------------------------ */
/* On the map                                                          */
/* ------------------------------------------------------------------ */

export default function FootprintDraw({ map, onDone, onCancel }: { map: maplibregl.Map; onDone: (corners: LatLon[]) => void; onCancel: () => void }) {
  const [corners, setCorners] = useState<LatLon[]>([]);
  const pal = useMapPalette();
  const palRef = useRef(pal);
  palRef.current = pal;
  const [rev, setRev] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Draw layers + click capture.
  useEffect(() => {
    const SRC = 'sv-draw';
    const add = () => {
      if (map.getSource(SRC)) return;
      const p = palRef.current;
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'sv-draw-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': p.drawFill, 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'sv-draw-line', type: 'line', source: SRC, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': p.drawLine, 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'sv-draw-pt', type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': p.drawPoint, 'circle-stroke-color': p.drawLine, 'circle-stroke-width': 2 } });
    };
    try {
      add();
    } catch {
      /* style not ready; the picker only mounts this once the map has loaded */
    }
    // A theme switch replaces the style: draw layers come back with the new palette.
    const onStyle = () => {
      try {
        add();
        setRev((r) => r + 1);
      } catch {
        /* still loading */
      }
    };
    map.on('style.load', onStyle);
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => setCorners((c) => (c.length < CORNERS ? [...c, { lat: e.lngLat.lat, lon: e.lngLat.lng }] : c));
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
      map.off('style.load', onStyle);
      canvas.style.cursor = prevCursor;
      try {
        for (const id of ['sv-draw-pt', 'sv-draw-line', 'sv-draw-fill']) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        /* map already removed */
      }
    };
  }, [map]);

  // Keep the drawing on the map in sync; finish at 4 corners.
  useEffect(() => {
    const src = map.getSource('sv-draw') as maplibregl.GeoJSONSource | undefined;
    const pts = corners.map((c) => [c.lon, c.lat]);
    const features: Feature[] = pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    if (pts.length >= 3) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
    else if (pts.length === 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
    src?.setData({ type: 'FeatureCollection', features });
    if (corners.length === CORNERS) {
      const t = setTimeout(() => doneRef.current(corners), 120);
      return () => clearTimeout(t);
    }
  }, [corners, map, rev]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addAtCentre = () => {
    const c = map.getCenter();
    setCorners((cs) => (cs.length < CORNERS ? [...cs, { lat: c.lat, lon: c.lng }] : cs));
  };

  return (
    <>
      {/* Centre crosshair for keyboard drawing */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2">
        <div className="absolute left-1/2 top-0 h-full w-px bg-accent" />
        <div className="absolute left-0 top-1/2 h-px w-full bg-accent" />
      </div>
      <div role="region" aria-label="Draw the building outline" className="absolute bottom-10 left-3 z-20 w-[min(360px,calc(100%-1.5rem))] rounded-xl bg-ink-900 p-3 text-xs text-ink-200 shadow-panel">
        <p className="text-[13px] font-semibold leading-5 text-paper">{DRAW_INSTRUCTION}</p>
        <p className="text-[11px] text-ink-400" aria-live="polite">
          <span className="num">{corners.length}</span> of <span className="num">{CORNERS}</span> corners
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" className={btn} onClick={addAtCentre} disabled={corners.length >= CORNERS}>
            Add corner at centre
          </button>
          <button type="button" className={btn} onClick={() => setCorners((c) => c.slice(0, -1))} disabled={!corners.length}>
            Undo corner
          </button>
          <button type="button" className={btn} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Blank metric canvas (tiles failed)                                  */
/* ------------------------------------------------------------------ */

export interface MetricCanvasProps {
  /** The coordinate at the canvas centre (shown as a cross). */
  center: LatLon;
  /** Drawn outline in ENU metres around `center` (after drawing). */
  outline: Vec2[] | null;
  /** Camera ground position in ENU metres around `center`. */
  camera: Vec2 | null;
  heading?: number | null;
  /** True while the user is clicking corners. */
  drawing: boolean;
  onCorners: (corners: Vec2[]) => void;
  onCameraMove: (p: Vec2) => void;
}

/** Blank `ink-900` canvas in metres: draw the 4 corners, then drag the camera dot. */
export function MetricCanvas({ center, outline, camera, heading, drawing, onCorners, onCameraMove }: MetricCanvasProps) {
  const [extent, setExtent] = useState(40); // half-width of the view (m)
  const [corners, setCorners] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>([0, 0]);
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const doneRef = useRef(onCorners);
  doneRef.current = onCorners;

  useEffect(() => {
    if (!drawing) setCorners([]);
  }, [drawing]);
  useEffect(() => {
    if (corners.length === CORNERS) {
      const t = setTimeout(() => doneRef.current(corners), 120);
      return () => clearTimeout(t);
    }
  }, [corners]);

  const toEnu = (clientX: number, clientY: number): Vec2 | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [Math.round(p.x * 10) / 10, Math.round(-p.y * 10) / 10];
  };

  const grid = useMemo(() => {
    const step = extent > 60 ? 10 : 5;
    const lines: number[] = [];
    for (let v = -Math.ceil(extent / step) * step; v <= extent; v += step) lines.push(v);
    return { step, lines };
  }, [extent]);

  const onKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const d = e.shiftKey ? 5 : 1;
    const move: Record<string, Vec2> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    if (move[e.key]) {
      e.preventDefault();
      setCursor((c) => [c[0] + move[e.key][0], c[1] + move[e.key][1]]);
    } else if ((e.key === 'Enter' || e.key === ' ') && drawing) {
      e.preventDefault();
      setCorners((cs) => (cs.length < CORNERS ? [...cs, cursor] : cs));
    } else if (e.key === 'Backspace' && drawing) {
      e.preventDefault();
      setCorners((cs) => cs.slice(0, -1));
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toEnu(e.clientX, e.clientY);
    if (!p) return;
    if (dragging) onCameraMove(p);
    else if (drawing) setCursor(p);
  };

  const poly = drawing ? corners : outline;
  const pts = (poly ?? []).map((p) => `${p[0]},${-p[1]}`).join(' ');
  const aim = camera && heading != null ? [camera[0] + Math.sin((heading * Math.PI) / 180) * 8, camera[1] + Math.cos((heading * Math.PI) / 180) * 8] : null;

  return (
    <div className="relative h-full w-full bg-ink-900">
      <svg
        ref={svgRef}
        role="application"
        aria-label={drawing ? `Drawing canvas in metres around ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}. Arrow keys move the cursor, Enter adds a corner, Backspace removes one.` : 'Building outline and camera position, in metres'}
        tabIndex={0}
        className="h-full w-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        viewBox={`${-extent} ${-extent} ${2 * extent} ${2 * extent}`}
        preserveAspectRatio="xMidYMid meet"
        onKeyDown={onKey}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setDragging(false)}
        onClick={(e) => {
          if (!drawing || dragging) return;
          const p = toEnu(e.clientX, e.clientY);
          if (p) setCorners((cs) => (cs.length < CORNERS ? [...cs, p] : cs));
        }}
        style={{ cursor: drawing ? 'crosshair' : 'default' }}
      >
        {grid.lines.map((v) => (
          <g key={v}>
            <line x1={v} x2={v} y1={-extent * 2} y2={extent * 2} className={v === 0 ? 'stroke-ink-500' : 'stroke-ink-700'} strokeWidth={extent / 400} />
            <line y1={v} y2={v} x1={-extent * 2} x2={extent * 2} className={v === 0 ? 'stroke-ink-500' : 'stroke-ink-700'} strokeWidth={extent / 400} />
          </g>
        ))}
        {/* Centre coordinate */}
        <circle cx={0} cy={0} r={extent / 120} className="fill-shade-400" />
        <text x={extent / 80} y={-extent / 80} fontSize={extent / 30} className="fill-ink-300">
          N ↑
        </text>
        {poly && poly.length >= 2 && <polygon points={pts} className={drawing ? 'fill-none stroke-accent' : 'fill-accent/25 stroke-accent'} strokeWidth={extent / 200} strokeDasharray={drawing ? `${extent / 60} ${extent / 120}` : undefined} />}
        {drawing && corners.map((c, i) => <circle key={i} cx={c[0]} cy={-c[1]} r={extent / 90} className="fill-knob stroke-accent" strokeWidth={extent / 300} />)}
        {drawing && (
          <g aria-hidden className="stroke-accent" strokeWidth={extent / 500}>
            <line x1={cursor[0] - extent / 40} x2={cursor[0] + extent / 40} y1={-cursor[1]} y2={-cursor[1]} />
            <line x1={cursor[0]} x2={cursor[0]} y1={-cursor[1] - extent / 40} y2={-cursor[1] + extent / 40} />
          </g>
        )}
        {camera && aim && <line x1={camera[0]} y1={-camera[1]} x2={aim[0]} y2={-aim[1]} className="stroke-obs" strokeWidth={extent / 300} strokeDasharray={`${extent / 80} ${extent / 160}`} />}
        {camera && (
          <circle
            role="button"
            aria-label="Camera position. Drag it, or use the arrow keys, to where you stood."
            tabIndex={drawing ? -1 : 0}
            cx={camera[0]}
            cy={-camera[1]}
            r={extent / 50}
            className="fill-obs stroke-knob"
            strokeWidth={extent / 300}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              if (drawing) return;
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDragging(true);
            }}
            onKeyDown={(e) => {
              const d = e.shiftKey ? 5 : 1;
              const move: Record<string, Vec2> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
              if (!move[e.key]) return;
              e.preventDefault();
              e.stopPropagation();
              onCameraMove([camera[0] + move[e.key][0], camera[1] + move[e.key][1]]);
            }}
          />
        )}
      </svg>
      <div className="absolute right-3 top-3 flex flex-col gap-0.5 rounded-xl bg-ink-900 p-1 shadow-panel">
        <button type="button" aria-label="Zoom in" className={iconBtn} onClick={() => setExtent((x) => Math.max(10, x / 1.5))}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button type="button" aria-label="Zoom out" className={iconBtn} onClick={() => setExtent((x) => Math.min(300, x * 1.5))}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M3 8h10" />
          </svg>
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-ink-900 px-2 py-1 text-[11px] text-ink-300 shadow-float">
        Grid: <span className="num">{grid.step}</span> m
      </div>
      {drawing && (
        <div className="absolute bottom-3 left-3 rounded-xl bg-ink-900 p-3 text-xs text-ink-200 shadow-panel">
          <p className="text-[13px] font-semibold leading-5 text-paper">{DRAW_INSTRUCTION}</p>
          <p className="text-[11px] text-ink-400" aria-live="polite">
            <span className="num">{corners.length}</span> of <span className="num">{CORNERS}</span> corners · the grid is in metres, north is up
          </p>
          <button type="button" className={btn + ' mt-2.5'} onClick={() => setCorners((c) => c.slice(0, -1))} disabled={!corners.length}>
            Undo corner
          </button>
        </div>
      )}
    </div>
  );
}
