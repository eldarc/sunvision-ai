/**
 * "Click the building" (step 2 of the quick upload).
 *
 * Footprints come from the basemap's vector tiles (lib/tiles.ts `loadFootprintsFromMap`):
 * no Overpass request is needed to pick a building. Hovering outlines a building in light blue,
 * clicking selects it (the UI accent blue, see mapPalette.ts), and a camera is placed right away:
 *   - EXIF GPS → the GPS point (observed), aimed at the building unless EXIF has a heading;
 *   - otherwise 15 m in front of the facade that faces the nearest street (assumed).
 * For an oblique street photo the build later re-aims this start camera along the street from the
 * photo's vanishing point (lib/vanishing obliqueStart), preferring the facade on a main street
 * (lib/tiles STREET_CLASS_PENALTY) when nobody chose a side; the pick panel says so.
 * The camera dot is draggable ("Optional: drag the dot to where you stood.").
 *
 * Location: EXIF GPS, or the search box (coordinates and map links are parsed locally, an
 * address goes to Photon, then Nominatim), or panning / clicking the map.
 *
 * Failures: a slow or dead geocoder keeps the field for coordinates and links; when the
 * map does not load, a blank metric canvas with lat/lon fields and FootprintDraw takes over.
 *
 * Direction picker: once a building is picked, FacadeArrows puts one button per facade on the map;
 * tapping one places the camera across from that facade (lib/tileBuildings `cameraForSide`). The
 * selected facade is outlined. The parent can also set the camera (flip, ±5°) through the handle.
 *
 * Theme: the basemap follows the resolved theme (OpenFreeMap dark / positron). Switching calls
 * `setStyle`, and our overlay sources and layers are re-added on `style.load`.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection } from 'geojson';
import clsx from 'clsx';
import type { Footprint, LatLon, Vec2 } from '../../schema/scene';
import { useThemeColors } from '../../lib/theme';
import { useMapPalette, type MapPalette } from './mapPalette';
import FacadeArrows from './FacadeArrows';
import { geocodeWithFallback, loadFootprintsFromMap, MIN_QUERY_ZOOM, type GeocodeHit, type Street } from '../../lib/tiles';
import { SIDE_CHIPS_MAX, cameraForSide, currentSide, draggedCamera, facadeSides, footprintFromCorners, footprintToLngLat, looksLikeLink, parseLocationInput, placeCamera, reprojectFootprints, ringCentroid, type CameraPlacement, type FacadeSide } from '../../lib/tileBuildings';
import { pointInRing } from '../../lib/sceneBuilder';
import { enuToLonLat, lonLatToEnu } from '../../engine/geo';
import { ringArea } from '../../lib/tiles';
import FootprintDraw, { MetricCanvas } from './FootprintDraw';

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** Data credit for the map; shown on the map on wide screens, under it on phones (QuickUpload). */
export const MAP_CREDIT = 'Buildings: OpenStreetMap (ODbL) via OpenFreeMap tiles · Search: Photon, Nominatim';

export const PICK_COPY = {
  title: 'Click the building',
  search: 'Address, or paste coordinates / a map link',
  dragCam: 'Optional: drag the dot to where you stood.',
  draw: 'Not on the map? Draw it',
  geocoder: "Address search isn't answering. Paste coordinates or a map link, or pan the map.",
  tiles: "The map didn't load. Enter coordinates and draw the building's outline.",
} as const;

/** Footprints are read for this radius around the target when the scene is built (m). */
export const SCENE_RADIUS = 150;
/** Overall budget for one address search (ms). */
const GEOCODE_BUDGET_MS = 6000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface Frame {
  /** ENU origin of footprints / streets. */
  origin: LatLon;
  footprints: Footprint[];
  streets: Street[];
}

export interface PickResult extends Frame {
  targetId: string;
  camera: CameraPlacement;
  /** 'tiles' = a basemap footprint; 'drawn' = outlined by the user. */
  source: 'tiles' | 'drawn';
  /** Warnings from the tile reader (incomplete coverage etc.). */
  warnings: string[];
}

export interface BuildingPickerHandle {
  /**
   * Re-read the footprints around the selected building (radius SCENE_RADIUS, the map may jump)
   * so the scene has its neighbours; falls back to the current selection when tiles fail.
   */
  finalize(): Promise<PickResult | null>;
  /** Replace the camera of the current selection (direction picker: flip, fine heading). */
  setCamera(cam: CameraPlacement): void;
}

export interface PhotoLocation {
  gps?: LatLon;
  heading?: number;
  headingRef?: string;
}

interface Props {
  photo: PhotoLocation;
  onChange: (sel: PickResult | null) => void;
  drawing: boolean;
  onDrawingChange: (v: boolean) => void;
  handle?: Ref<BuildingPickerHandle>;
  /** Called with a short status for screen readers / the side panel. */
  onStatus?: (s: string | null) => void;
}

type MapState = 'loading' | 'ready' | 'failed';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

function polygonFeature(fp: Footprint, origin: LatLon): Feature {
  const rings = [footprintToLngLat(fp, origin), ...(fp.holes ?? []).map((h) => footprintToLngLat({ ring: h }, origin))];
  return { type: 'Feature', properties: { id: fp.id }, geometry: { type: 'Polygon', coordinates: rings } };
}

/** Largest radius (m, ≤ cap) around the map centre that is fully on screen. */
function visibleRadius(map: maplibregl.Map, cap = 250): number {
  const b = map.getBounds();
  const c = map.getCenter();
  const o = { lat: c.lat, lon: c.lng };
  const e = lonLatToEnu(o, { lat: c.lat, lon: b.getEast() })[0];
  const n = lonLatToEnu(o, { lat: b.getNorth(), lon: c.lng })[1];
  return Math.max(20, Math.min(cap, Math.abs(e), Math.abs(n)) * 0.95);
}

/** Jump so that a circle of `radius` m around `ll` is on screen at zoom ≥ MIN_QUERY_ZOOM. */
function viewForRadius(map: maplibregl.Map, ll: LatLon, radius: number) {
  const el = map.getContainer();
  const px = Math.max(200, Math.min(el.clientWidth, el.clientHeight));
  const mppNeeded = (2.3 * radius) / px;
  const zFit = Math.log2((40075016.686 * Math.cos((ll.lat * Math.PI) / 180)) / (512 * mppNeeded));
  const zoom = Math.max(MIN_QUERY_ZOOM, Math.min(map.getZoom(), zFit));
  map.jumpTo({ center: [ll.lon, ll.lat], zoom });
}

/** Camera dot: a white ring and a soft drop shadow, so it reads as a draggable handle. */
const camShadow = (pal: MapPalette) => `0 0 0 2px ${pal.halo}, 0 1px 4px rgb(0 0 0 / 0.45)`;

/** Coordinate input (blank-canvas fallback): a grey well, blue outline on focus. */
const field = 'num h-7 w-32 rounded-md bg-ink-800 px-2 text-base text-paper focus:outline-1 focus:outline-accent sm:text-xs pointer-coarse:h-11';

/** Add our sources and layers to the current style (idempotent; called again after setStyle). */
function installOverlay(m: maplibregl.Map, pal: MapPalette) {
  for (const id of ['sv-fp', 'sv-sel', 'sv-aim', 'sv-facade']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: fc([]) });
  const add = (l: maplibregl.LayerSpecification) => {
    if (!m.getLayer(l.id)) m.addLayer(l);
  };
  add({ id: 'sv-fp-fill', type: 'fill', source: 'sv-fp', paint: { 'fill-color': pal.footprint, 'fill-opacity': pal.footprintFillOpacity } });
  add({ id: 'sv-fp-line', type: 'line', source: 'sv-fp', paint: { 'line-color': pal.footprint, 'line-opacity': 0.55, 'line-width': 0.8 } });
  add({ id: 'sv-hover', type: 'line', source: 'sv-fp', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': pal.hover, 'line-width': 2.5 } });
  add({ id: 'sv-sel-fill', type: 'fill', source: 'sv-sel', paint: { 'fill-color': pal.selFill, 'fill-opacity': pal.selFillOpacity } });
  add({ id: 'sv-sel-line', type: 'line', source: 'sv-sel', paint: { 'line-color': pal.selLine, 'line-width': 2 } });
  add({ id: 'sv-facade', type: 'line', source: 'sv-facade', layout: { 'line-cap': 'round' }, paint: { 'line-color': pal.facade, 'line-width': 5 } });
  add({ id: 'sv-aim', type: 'line', source: 'sv-aim', paint: { 'line-color': pal.camera, 'line-width': 2, 'line-dasharray': [2, 1] } });
}

function cameraFor(target: Footprint, frame: Frame, photo: PhotoLocation, prev: { cam: CameraPlacement; origin: LatLon } | null): CameraPlacement {
  if (prev && prev.cam.basis === 'manual') {
    const p = lonLatToEnu(frame.origin, enuToLonLat(prev.origin, prev.cam.position));
    return draggedCamera(p, target);
  }
  return placeCamera(target, frame.footprints, frame.streets, {
    gps: photo.gps ? lonLatToEnu(frame.origin, photo.gps) : undefined,
    exifHeading: photo.heading,
    exifHeadingRef: photo.headingRef,
  });
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function BuildingPicker({ photo, onChange, drawing, onDrawingChange, handle, onStatus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [mapState, setMapState] = useState<MapState>('loading');
  const [zoom, setZoom] = useState<number>(photo.gps ? 18 : 3);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameInfo, setFrameInfo] = useState<{ loading: boolean; warnings: string[] }>({ loading: false, warnings: [] });
  const [sel, setSel] = useState<PickResult | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const photoRef = useRef(photo);
  photoRef.current = photo;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const hoverRef = useRef<string | null>(null);
  const camMarker = useRef<maplibregl.Marker | null>(null);
  const themeColors = useThemeColors();
  const pal = useMapPalette();
  const palRef = useRef(pal);
  palRef.current = pal;
  const styleUrl = useRef(themeColors.mapStyle);
  /** Bumped whenever our overlay was (re)installed, so the data effects push their data again. */
  const [overlayRev, setOverlayRev] = useState(0);

  // Search
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [geocoderDown, setGeocoderDown] = useState(false);
  const searchCtl = useRef<AbortController | null>(null);

  // Blank-canvas fallback (tiles failed)
  const [manualCenter, setManualCenter] = useState<LatLon | null>(photo.gps ?? null);
  const [latStr, setLatStr] = useState(photo.gps ? photo.gps.lat.toFixed(6) : '');
  const [lonStr, setLonStr] = useState(photo.gps ? photo.gps.lon.toFixed(6) : '');

  const select = useCallback((s: PickResult | null) => {
    setSel(s);
    onChangeRef.current(s);
  }, []);

  // Direction picker: the facades of the picked building, and the one the camera shows.
  const selTarget = sel?.footprints.find((f) => f.id === sel.targetId) ?? null;
  const sides = useMemo<FacadeSide[]>(() => (selTarget ? facadeSides(selTarget, { max: SIDE_CHIPS_MAX }) : []), [selTarget]);
  const side = useMemo(() => (sel && selTarget ? currentSide(selTarget, sides, sel.camera) : null), [sel, selTarget, sides]);
  const pickSide = useCallback(
    (sd: FacadeSide) => {
      const s = selRef.current;
      if (!s) return;
      // The photo's GPS point is kept when it stands in front of the picked side (cameraForSide).
      const g = photoRef.current.gps;
      const camera = cameraForSide(sd, s.footprints, { targetId: s.targetId, gps: g ? lonLatToEnu(s.origin, g) : undefined });
      select({ ...s, camera });
    },
    [select],
  );

  /* ---------------- map lifecycle ---------------- */
  useEffect(() => {
    if (!host.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: host.current,
        style: themeColors.mapStyle,
        center: photo.gps ? [photo.gps.lon, photo.gps.lat] : [4.9, 50],
        zoom: photo.gps ? 18 : 3,
        attributionControl: { compact: true },
        // Phones: the map fills most of the scrolling column, so one finger scrolls the page and
        // two fingers move the map (taps on buildings and arrows still work).
        cooperativeGestures: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
      });
    } catch {
      setMapState('failed');
      return;
    }
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    let loaded = false;
    const failTimer = setTimeout(() => {
      if (!loaded) setMapState('failed');
    }, 15000);
    m.on('error', () => {
      if (!loaded) setMapState('failed');
    });
    m.on('load', () => {
      loaded = true;
      clearTimeout(failTimer);
      // A late load (slow network, background tab) recovers the map unless the user already
      // drew a building on the blank canvas.
      installOverlay(m, palRef.current);
      setOverlayRev((r) => r + 1);
      setMapState((st) => (st === 'failed' && selRef.current ? 'failed' : 'ready'));
      setMap(m);
    });
    // After a theme switch (setStyle) the overlay is gone: put it back.
    m.on('style.load', () => {
      if (!loaded) return;
      try {
        installOverlay(m, palRef.current);
        setOverlayRev((r) => r + 1);
      } catch {
        /* style still settling; the next style.load retries */
      }
    });
    m.on('zoomend', () => setZoom(m.getZoom()));
    if (import.meta.env.DEV) (window as unknown as { __quickMap?: maplibregl.Map }).__quickMap = m;
    return () => {
      clearTimeout(failTimer);
      camMarker.current?.remove();
      camMarker.current = null;
      m.remove();
      setMap(null);
    };
    // The map is created once; later GPS changes are handled by flyTo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: swap the basemap; our overlay is re-added on style.load.
  useEffect(() => {
    if (!map || styleUrl.current === themeColors.mapStyle) return;
    styleUrl.current = themeColors.mapStyle;
    try {
      map.setStyle(themeColors.mapStyle, { diff: false });
    } catch {
      /* keep the current basemap */
    }
  }, [map, themeColors.mapStyle]);

  // Same style, other palette (cannot happen with the two built-in themes, but keep paint in sync).
  useEffect(() => {
    if (!map) return;
    try {
      map.setPaintProperty('sv-fp-fill', 'fill-color', pal.footprint);
      map.setPaintProperty('sv-fp-line', 'line-color', pal.footprint);
      map.setPaintProperty('sv-hover', 'line-color', pal.hover);
      map.setPaintProperty('sv-sel-fill', 'fill-color', pal.selFill);
      map.setPaintProperty('sv-sel-line', 'line-color', pal.selLine);
      map.setPaintProperty('sv-facade', 'line-color', pal.facade);
      map.setPaintProperty('sv-aim', 'line-color', pal.camera);
    } catch {
      /* layers not there yet (style loading) */
    }
    const el = camMarker.current?.getElement();
    if (el) {
      el.style.background = pal.camera;
      el.style.boxShadow = camShadow(pal);
    }
  }, [map, pal, overlayRev]);

  useEffect(() => {
    if (!photo.gps) searchRef.current?.focus();
  }, [photo.gps]);

  /* ---------------- footprints from tiles ---------------- */
  const loadSeq = useRef(0);
  const loadFrame = useCallback(async (m: maplibregl.Map) => {
    if (m.getZoom() < MIN_QUERY_ZOOM) {
      setFrameInfo({ loading: false, warnings: [] });
      return;
    }
    const seq = ++loadSeq.current;
    const c = m.getCenter();
    const origin = { lat: c.lat, lon: c.lng };
    setFrameInfo((f) => ({ ...f, loading: true }));
    try {
      const load = await loadFootprintsFromMap(m, origin, visibleRadius(m), { waitMs: 4000 });
      if (seq !== loadSeq.current) return;
      setFrame({ origin, footprints: load.footprints, streets: load.streets });
      setFrameInfo({ loading: false, warnings: load.warnings });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setFrameInfo({ loading: false, warnings: [e instanceof Error ? e.message : String(e)] });
    }
  }, []);

  useEffect(() => {
    if (!map) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(t);
      t = setTimeout(() => void loadFrame(map), 250);
    };
    map.on('moveend', schedule);
    schedule();
    return () => {
      clearTimeout(t);
      map.off('moveend', schedule);
    };
  }, [map, loadFrame]);

  // Draw the loaded footprints.
  useEffect(() => {
    const src = map?.getSource('sv-fp') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(fc(frame ? frame.footprints.map((f) => polygonFeature(f, frame.origin)) : []));
  }, [map, frame, overlayRev]);

  // Selection highlight, camera marker and aim line.
  useEffect(() => {
    if (!map) return;
    const selSrc = map.getSource('sv-sel') as maplibregl.GeoJSONSource | undefined;
    const aimSrc = map.getSource('sv-aim') as maplibregl.GeoJSONSource | undefined;
    const target = sel?.footprints.find((f) => f.id === sel.targetId);
    selSrc?.setData(fc(sel && target ? [polygonFeature(target, sel.origin)] : []));
    const camLL = sel ? enuToLonLat(sel.origin, sel.camera.position) : photo.gps ?? null;
    if (!camLL) {
      camMarker.current?.remove();
      camMarker.current = null;
      aimSrc?.setData(fc([]));
      return;
    }
    if (!camMarker.current) {
      const el = document.createElement('div');
      el.className = 'relative h-4 w-4 cursor-grab rounded-full';
      el.style.background = palRef.current.camera;
      el.style.boxShadow = camShadow(palRef.current);
      // A larger invisible hit area so the dot can be grabbed with a finger.
      const hit = document.createElement('span');
      hit.className = 'absolute -inset-3.5 rounded-full';
      el.append(hit);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'Camera position (drag to where you stood)');
      const label = document.createElement('span');
      // Phones: no label on the map (it would be clipped at the map's edge); the side panel says the same.
      label.className = 'sv-cam-label pointer-events-none absolute left-1/2 top-7 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-200 shadow-float sm:block';
      el.append(label);
      camMarker.current = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat([camLL.lon, camLL.lat]).addTo(map);
      camMarker.current.on('dragend', () => {
        const s = selRef.current;
        const ll = camMarker.current!.getLngLat();
        if (!s) return;
        const target = s.footprints.find((f) => f.id === s.targetId);
        if (!target) return;
        const p = lonLatToEnu(s.origin, { lat: ll.lat, lon: ll.lng });
        select({ ...s, camera: draggedCamera(p, target, s.camera) });
      });
    } else camMarker.current.setLngLat([camLL.lon, camLL.lat]);
    const label = camMarker.current.getElement().querySelector('.sv-cam-label') as HTMLElement | null;
    if (label) {
      label.textContent = sel && sel.camera.basis !== 'gps' && sel.camera.basis !== 'manual' ? PICK_COPY.dragCam : '';
      label.style.display = label.textContent ? '' : 'none';
    }
    // The facade the camera looks at, outlined.
    const facadeSrc = map.getSource('sv-facade') as maplibregl.GeoJSONSource | undefined;
    if (sel && target && side) {
      const n = target.ring.length;
      facadeSrc?.setData(
        fc(
          side.edges.map((i) => {
            const a = enuToLonLat(sel.origin, target.ring[i]);
            const b = enuToLonLat(sel.origin, target.ring[(i + 1) % n]);
            return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } } as Feature;
          }),
        ),
      );
    } else facadeSrc?.setData(fc([]));
    camMarker.current.setDraggable(!!sel);
    if (sel && target) {
      const c = ringCentroid(target.ring);
      const d = Math.hypot(c[0] - sel.camera.position[0], c[1] - sel.camera.position[1]);
      const h = (sel.camera.heading * Math.PI) / 180;
      const end = enuToLonLat(sel.origin, [sel.camera.position[0] + Math.sin(h) * d, sel.camera.position[1] + Math.cos(h) * d]);
      aimSrc?.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[camLL.lon, camLL.lat], [end.lon, end.lat]] } }]));
    } else aimSrc?.setData(fc([]));
  }, [map, sel, photo.gps, select, side, overlayRev]);

  /* ---------------- hover + click ---------------- */
  const pickFootprint = useCallback(
    (id: string) => {
      const f = frameRef.current;
      const target = f?.footprints.find((x) => x.id === id);
      if (!f || !target) return;
      const prev = selRef.current;
      const camera = cameraFor(target, f, photoRef.current, prev ? { cam: prev.camera, origin: prev.origin } : null);
      select({ ...f, targetId: id, camera, source: 'tiles', warnings: [] });
    },
    [select],
  );

  useEffect(() => {
    if (!map) return;
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (drawingRef.current) return;
      const f = map.getZoom() >= MIN_QUERY_ZOOM ? map.queryRenderedFeatures(e.point, { layers: ['sv-fp-fill'] })[0] : undefined;
      const id = (f?.properties?.id as string | undefined) ?? '';
      if (id === hoverRef.current) return;
      hoverRef.current = id;
      map.setFilter('sv-hover', ['==', ['get', 'id'], id]);
      map.getCanvas().style.cursor = id ? 'pointer' : '';
    };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (drawingRef.current) return;
      if (map.getZoom() < MIN_QUERY_ZOOM) {
        map.flyTo({ center: e.lngLat, zoom: 18 });
        return;
      }
      const f = map.queryRenderedFeatures(e.point, { layers: ['sv-fp-fill'] })[0];
      const id = f?.properties?.id as string | undefined;
      if (id) pickFootprint(id);
    };
    map.on('mousemove', onMove);
    map.on('click', onClick);
    return () => {
      map.off('mousemove', onMove);
      map.off('click', onClick);
    };
  }, [map, pickFootprint]);

  // Keyboard alternative: pick the building under the map centre.
  const pickAtCentre = () => {
    if (!map) return;
    const f = map.queryRenderedFeatures(map.project(map.getCenter()), { layers: ['sv-fp-fill'] })[0];
    const id = f?.properties?.id as string | undefined;
    if (id) pickFootprint(id);
    else onStatus?.('No building at the centre of the map.');
  };

  /* ---------------- drawn footprint ---------------- */
  const onDrawn = (corners: LatLon[], origin: LatLon, base: Frame | null) => {
    try {
      const fp = footprintFromCorners(corners, origin);
      const others = base ? reprojectFootprints(base.footprints, base.origin, origin).filter((f) => !pointInRing(ringCentroid(f.ring), fp.ring)) : [];
      const streets = base ? base.streets.map((s) => ({ ...s, line: s.line.map((p) => lonLatToEnu(origin, enuToLonLat(base.origin, p))) })) : [];
      const f: Frame = { origin, footprints: [fp, ...others], streets };
      const prev = selRef.current;
      const camera = cameraFor(fp, f, photoRef.current, prev ? { cam: prev.camera, origin: prev.origin } : null);
      select({ ...f, targetId: fp.id, camera, source: 'drawn', warnings: [] });
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : String(e));
    }
    onDrawingChange(false);
  };

  /* ---------------- finalize (called on "Build") ---------------- */
  useImperativeHandle(
    handle,
    () => ({
      async finalize() {
        const s = selRef.current;
        if (!s) return null;
        if (s.source === 'drawn' || !map) return s;
        const old = s.footprints.find((f) => f.id === s.targetId);
        if (!old) return s;
        const targetLL = enuToLonLat(s.origin, ringCentroid(old.ring));
        try {
          viewForRadius(map, targetLL, SCENE_RADIUS);
          const load = await loadFootprintsFromMap(map, targetLL, SCENE_RADIUS, { waitMs: 6000 });
          if (!load.footprints.length) return s;
          const oldHere = reprojectFootprints([old], s.origin, targetLL)[0];
          const oldArea = Math.abs(ringArea(oldHere.ring));
          let target =
            load.footprints.find((f) => f.id === s.targetId) ??
            load.footprints.find((f) => {
              const a = Math.abs(ringArea(f.ring));
              return pointInRing([0, 0], f.ring) && a > oldArea * 0.5 && a < oldArea * 2;
            });
          let footprints = load.footprints;
          if (!target) {
            target = oldHere;
            footprints = [oldHere, ...load.footprints.filter((f) => !pointInRing(ringCentroid(f.ring), oldHere.ring) && !pointInRing(ringCentroid(oldHere.ring), f.ring))];
          }
          const camPos = lonLatToEnu(targetLL, enuToLonLat(s.origin, s.camera.position));
          return { origin: targetLL, footprints, streets: load.streets, targetId: target.id, camera: { ...s.camera, position: camPos }, source: 'tiles', warnings: load.warnings };
        } catch {
          return s;
        }
      },
      setCamera(cam: CameraPlacement) {
        const s = selRef.current;
        if (s) select({ ...s, camera: cam });
      },
    }),
    [map, select],
  );

  /* ---------------- search ---------------- */
  const goTo = (ll: LatLon, z = 18) => {
    setHits([]);
    if (mapState === 'failed' || !map) {
      setManualCenter(ll);
      setLatStr(ll.lat.toFixed(6));
      setLonStr(ll.lon.toFixed(6));
      return;
    }
    map.flyTo({ center: [ll.lon, ll.lat], zoom: Math.max(MIN_QUERY_ZOOM + 1, Math.min(19, z)) });
  };

  const submitSearch = async () => {
    const text = q.trim();
    setSearchMsg(null);
    setHits([]);
    if (!text) return;
    const parsed = parseLocationInput(text);
    if (parsed) {
      goTo(parsed, parsed.zoom ?? 18);
      return;
    }
    if (looksLikeLink(text)) {
      setSearchMsg("Couldn't read coordinates from this link (short links need a network lookup). Open it and paste the coordinates instead.");
      return;
    }
    searchCtl.current?.abort();
    const ctl = new AbortController();
    searchCtl.current = ctl;
    const timer = setTimeout(() => ctl.abort(), GEOCODE_BUDGET_MS);
    setSearching(true);
    try {
      const c = map?.getCenter();
      const res = await geocodeWithFallback(text, { signal: ctl.signal, timeoutMs: 4000, limit: 5, near: c && map && map.getZoom() > 8 ? { lat: c.lat, lon: c.lng } : undefined });
      if (searchCtl.current !== ctl) return;
      setGeocoderDown(false);
      if (!res.length) setSearchMsg('No match. Try a street and house number, or paste coordinates.');
      else if (res.length === 1) goTo(res[0]);
      else setHits(res);
    } catch {
      if (searchCtl.current !== ctl) return;
      setGeocoderDown(true);
      setHits([]);
      setSearchMsg(PICK_COPY.geocoder);
    } finally {
      clearTimeout(timer);
      if (searchCtl.current === ctl) setSearching(false);
    }
  };

  /* ---------------- blank canvas (tiles failed) ---------------- */
  const applyLatLon = () => {
    const p = parseLocationInput(`${latStr}, ${lonStr}`);
    if (p) setManualCenter({ lat: p.lat, lon: p.lon });
    else onStatus?.('Enter a latitude between −90 and 90 and a longitude between −180 and 180.');
  };
  useEffect(() => {
    if (mapState === 'failed' && manualCenter && !sel) onDrawingChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapState, manualCenter]);

  const failed = mapState === 'failed';
  const canvasTarget = failed && sel ? sel.footprints.find((f) => f.id === sel.targetId) : null;
  const canvasOffset = (p: Vec2): Vec2 => (sel && manualCenter ? lonLatToEnu(manualCenter, enuToLonLat(sel.origin, p)) : p);

  const statusLine = (() => {
    if (failed) return null;
    if (mapState === 'loading') return 'Loading the map…';
    if (zoom < MIN_QUERY_ZOOM) return 'Zoom in (or click the map) to see the buildings.';
    if (frameInfo.loading && !frame) return 'Reading buildings from the map…';
    if (frame && !frame.footprints.length) return 'No buildings in the map data here.';
    return null;
  })();

  return (
    <div className="relative h-full min-h-[300px] w-full overflow-hidden bg-ink-950 lg:min-h-[420px]">
      <div ref={host} style={{ position: 'absolute', inset: 0, zIndex: 0 }} className={clsx(failed && 'invisible')} aria-hidden={failed || undefined} aria-label="Map: click the photographed building" role="region" />

      {failed && (
        <div className="absolute inset-0 z-[1] flex flex-col">
          <div className="border-b border-ink-700 bg-ink-900 px-3 pb-3 pt-16 text-xs text-ink-200">
            <p role="alert" className="text-xs font-medium text-paper">
              {PICK_COPY.tiles}
            </p>
            <form
              className="mt-2.5 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyLatLon();
              }}
            >
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-ink-400">Latitude</span>
                <input inputMode="decimal" value={latStr} onChange={(e) => setLatStr(e.target.value)} className={field} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-ink-400">Longitude</span>
                <input inputMode="decimal" value={lonStr} onChange={(e) => setLonStr(e.target.value)} className={field} />
              </label>
              <button type="submit" className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11">
                Use this point
              </button>
            </form>
          </div>
          <div className="relative min-h-0 flex-1">
            {manualCenter ? (
              <MetricCanvas
                center={manualCenter}
                drawing={drawing}
                outline={canvasTarget ? canvasTarget.ring.map(canvasOffset) : null}
                camera={sel ? canvasOffset(sel.camera.position) : null}
                heading={sel?.camera.heading ?? null}
                onCorners={(cs) => onDrawn(cs.map((p) => enuToLonLat(manualCenter, p)), manualCenter, null)}
                onCameraMove={(p) => {
                  if (!sel || !canvasTarget) return;
                  const inSel = lonLatToEnu(sel.origin, enuToLonLat(manualCenter, p));
                  select({ ...sel, camera: draggedCamera(inSel, canvasTarget, sel.camera) });
                }}
              />
            ) : (
              <p className="grid h-full place-items-center p-6 text-center text-xs text-ink-400">Enter the coordinates of the building (or paste them in the search box) to start drawing.</p>
            )}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="absolute left-3 top-3 z-20 w-[min(420px,calc(100%-4.5rem))]">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void submitSearch();
          }}
          className="flex gap-1 rounded-xl bg-ink-900 p-1 shadow-panel"
        >
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={PICK_COPY.search}
            aria-label={PICK_COPY.search}
            className="h-7 min-w-0 flex-1 rounded-md bg-ink-800 px-2 text-base text-paper placeholder:text-ink-400 focus:outline-1 focus:outline-accent sm:text-xs pointer-coarse:h-11"
          />
          <button type="submit" disabled={searching} className="inline-flex h-7 min-w-9 items-center justify-center rounded-md px-2.5 text-xs font-medium text-paper hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 pointer-coarse:h-11 pointer-coarse:min-w-11">
            {searching ? 'Searching…' : 'Go'}
          </button>
        </form>
        {hits.length > 0 && !geocoderDown && (
          <ul className="mt-1 overflow-hidden rounded-lg bg-ink-900 p-1 text-xs shadow-panel" aria-label="Search results">
            {hits.map((h, i) => (
              <li key={i}>
                <button type="button" className="block min-h-7 w-full truncate rounded-md px-2 py-1.5 text-left text-ink-200 hover:bg-ink-800 hover:text-paper focus-visible:bg-selected focus-visible:text-paper focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:py-3" onClick={() => goTo(h)}>
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {searchMsg && (
          <p role="status" className="mt-1 rounded-lg bg-ink-900 px-3 py-2 text-xs text-paper shadow-panel">
            {searchMsg}
          </p>
        )}
        {!failed && statusLine && (
          <p role="status" className="mt-1 inline-block rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs text-ink-200 shadow-panel">
            {statusLine}
          </p>
        )}
      </div>

      {/* Map tools */}
      {!failed && map && !drawing && (
        <div className="absolute bottom-10 left-3 z-10 flex flex-wrap gap-1.5">
          {zoom >= MIN_QUERY_ZOOM && (
            <button type="button" onClick={pickAtCentre} className={clsx('h-7 rounded-lg bg-ink-900 px-3 text-xs font-medium text-paper shadow-panel hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11', sel && 'hidden lg:block')}>
              Pick the building at the centre
            </button>
          )}
        </div>
      )}
      {!failed && map && !drawing && sel && sides.length > 0 && <FacadeArrows map={map} origin={sel.origin} sides={sides} selectedEdge={side?.edge ?? null} onPick={pickSide} />}
      {!failed && map && drawing && (
        <FootprintDraw
          map={map}
          onCancel={() => onDrawingChange(false)}
          onDone={(corners) => {
            const c = map.getCenter();
            onDrawn(corners, frameRef.current?.origin ?? { lat: c.lat, lon: c.lng }, frameRef.current);
          }}
        />
      )}
      <p className="pointer-events-none absolute bottom-1 left-3 z-10 hidden max-w-[55%] text-[11px] leading-[14px] text-ink-400 lg:block">{MAP_CREDIT}</p>
    </div>
  );
}
