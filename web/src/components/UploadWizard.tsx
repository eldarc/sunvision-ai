/**
 * Manual upload wizard (#/upload/manual): photo → camera position → viewing direction → building.
 *
 * Building footprints come from the basemap's vector tiles (lib/tiles.ts `loadFootprintsFromMap`,
 * the same source as the quick upload's BuildingPicker), so they appear as soon as the map has
 * its tiles and picking never waits on a public API. The OpenStreetMap Overpass API is only an
 * optional enrichment (OSM ids, height tags, trees, roads), fetched in the background once a
 * building is picked and awaited for at most OVERPASS_BUDGET_MS when the twin is built.
 *
 * The scene is built by lib/tileBuildings.ts `prepareTileScene` with the user's own camera
 * (position and heading keep their provenance: 'observed' from EXIF or 'manual' from the map;
 * the auto-aligner never moves 'manual' parameters). A building missing from the map can be
 * outlined by hand (FootprintDraw).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import exifr from 'exifr';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { Btn, Prov, Wordmark } from './ui';
import { useThemeColors } from '../lib/theme';
import { fetchOsmAround, geocode, type GeocodeResult, type OsmElement } from '../lib/osm';
import { bearingOf, enuToLonLat, lonLatToEnu } from '../engine';
import type { FacadeAnalysis, ImageInfo, LatLon } from '../schema/scene';
import { AnalyzeError, analyzePhoto, askForKey, detectionCheck, fetchHealth, noticeForError, type ApiHealth } from '../lib/analyzeApi';
import { hasRoboflowKey, subscribeRoboflowKey, subscribeRoboflowKeySaved } from '../lib/roboflowKey';
import { loadFootprintsFromMap, MIN_QUERY_ZOOM } from '../lib/tiles';
import { footprintFromCorners, prepareTileScene, ringCentroid, type TileSceneInput } from '../lib/tileBuildings';
import { useMapPalette } from './upload/mapPalette';
import FootprintDraw from './upload/FootprintDraw';
import { OVERPASS_BUDGET_MS, PICK_RADIUS, carryTarget, footprintAt, frameFeatures, mergeFrames, metersPerPixel, timeBoxed, wizardCamera, type WizardFrame } from './upload/wizard/wizardFrame';

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Footprints are read for this radius around the target when the scene is built (m), as in the quick upload. */
const SCENE_RADIUS = 150;
/** Largest radius (m) read for the visible map. */
const VIEW_RADIUS_CAP = 300;

interface Photo {
  file: File;
  url: string;
  width: number;
  height: number;
  gps?: LatLon;
  heading?: number;
  /** EXIF GPSImgDirectionRef: 'M' (magnetic) or 'T' (true north). */
  headingRef?: string;
  focal35?: number;
  focalMm?: number;
  captureTime?: string;
  make?: string;
  model?: string;
}

/** Radius (m) around the map centre that covers the whole viewport (half its diagonal), capped. */
function viewRadius(map: maplibregl.Map): number {
  const b = map.getBounds();
  const c = map.getCenter();
  const o = { lat: c.lat, lon: c.lng };
  const ne = lonLatToEnu(o, { lat: b.getNorth(), lon: b.getEast() });
  return Math.max(30, Math.min(VIEW_RADIUS_CAP, Math.hypot(ne[0], ne[1])));
}

/** True when a circle of `radius` m around `ll` is on screen at a zoom with full-detail building tiles. */
function radiusOnScreen(map: maplibregl.Map, ll: LatLon, radius: number): boolean {
  if (map.getZoom() < MIN_QUERY_ZOOM) return false;
  const b = map.getBounds();
  const sw = enuToLonLat(ll, [-radius, -radius]);
  const ne = enuToLonLat(ll, [radius, radius]);
  return b.getWest() <= sw.lon && b.getSouth() <= sw.lat && b.getEast() >= ne.lon && b.getNorth() >= ne.lat;
}

/** Jump so that a circle of `radius` m around `ll` is on screen at zoom ≥ MIN_QUERY_ZOOM. */
function showRadius(map: maplibregl.Map, ll: LatLon, radius: number) {
  const el = map.getContainer();
  const px = Math.max(200, Math.min(el.clientWidth, el.clientHeight));
  const zFit = Math.log2((40075016.686 * Math.cos((ll.lat * Math.PI) / 180)) / (512 * ((2.3 * radius) / px)));
  map.jumpTo({ center: [ll.lon, ll.lat], zoom: Math.max(MIN_QUERY_ZOOM, Math.min(map.getZoom(), zFit)) });
}

/** OSM element ids ('way/…', 'relation/…') link to openstreetmap.org; tile and drawn ids do not. */
const osmLink = (id: string) => (/^(way|relation|node)\/\d+$/.test(id) ? `https://www.openstreetmap.org/${id}` : null);

type Health = { apiKeyConfigured: boolean; providers: { hosted: boolean; local: boolean }; depth: { transformers: boolean } } | null;

export default function UploadWizard() {
  const set = useStore((s) => s.set);
  const loadScene = useStore((s) => s.loadScene);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cam, setCam] = useState<LatLon | null>(null);
  const [camProv, setCamProv] = useState<'observed' | 'manual'>('manual');
  const [heading, setHeading] = useState<number | null>(null);
  const [headingProv, setHeadingProv] = useState<'observed' | 'manual'>('manual');
  const [mode, setMode] = useState<'camera' | 'aim' | 'building'>('camera');
  /** Footprints read from the map tiles around the visible map (null until the first read). */
  const [frame, setFrame] = useState<WizardFrame | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameErr, setFrameErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(3);
  /** A click in 'building' mode that is being resolved (tiles loading) or found no building. */
  const [pickState, setPickState] = useState<'reading' | 'zooming' | 'miss' | null>(null);
  /** The user is outlining a building that is missing from the map (FootprintDraw). */
  const [drawing, setDrawing] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [health, setHealth] = useState<Health>(null);
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [provider, setProvider] = useState<'hosted' | 'local'>('hosted');
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  /** The last analysis failed for a reason a (different) Roboflow key would fix. */
  const [keyHelps, setKeyHelps] = useState(false);
  const sharedQuota = useStore((s) => s.sharedQuota);
  const mapStyle = useThemeColors().mapStyle;
  const mapStyleRef = useRef(mapStyle);
  /** Overlay colours for the current basemap (MapLibre paint cannot read CSS variables). */
  const palette = useMapPalette();
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  /** MapLibre could not start (no WebGL): the wizard explains instead of crashing the page. */
  const [mapFailed, setMapFailed] = useState(false);
  /** One-shot "retry the analysis once a key is saved" listener. */
  const keyRetryOff = useRef<(() => void) | null>(null);
  useEffect(() => () => keyRetryOff.current?.(), []);
  /** Bumped every time the map (re)loads a style, so sources/layers and their data are re-applied. */
  const [styleRev, setStyleRev] = useState(0);
  const mapHost = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const camMarker = useRef<maplibregl.Marker | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const camRef = useRef(cam);
  camRef.current = cam;
  // Refs are updated during render and, for frame/target, right where they are set, so map event
  // handlers and async reads always see the latest values.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const targetRef = useRef(target);
  targetRef.current = target;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  /** A building-mode click waiting for the next frame read (the map was zooming in). */
  const pendingPick = useRef<LatLon | null>(null);
  const pickAtRef = useRef<(ll: LatLon) => void>(() => {});
  /** Background Overpass enrichment for the picked building (never blocks picking or building). */
  const osmJob = useRef<{ key: string; started: number; ctl: AbortController; p: Promise<OsmElement[] | null> } | null>(null);
  useEffect(() => () => osmJob.current?.ctl.abort(), []);

  // The user's own Roboflow key (sent per request by analyzePhoto) makes hosted inference available
  // even when the server has no shared key.
  const userKey = useSyncExternalStore(subscribeRoboflowKey, hasRoboflowKey, hasRoboflowKey);
  useEffect(() => {
    // fetchHealth also refreshes store.sharedQuota.
    fetchHealth()
      .then((h) => {
        setApiHealth(h);
        setHealth(
          h ? { apiKeyConfigured: !!h.apiKeyConfigured, providers: { hosted: !!h.providers?.hosted, local: !!h.providers?.local }, depth: { transformers: !!h.depth?.transformers } } : null,
        );
      })
      .catch(() => {
        setHealth(null);
        setApiHealth(null);
      })
      .finally(() => setHealthChecked(true));
  }, []);

  // ---- map --------------------------------------------------------------------------------------
  useEffect(() => {
    if (!mapHost.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({ container: mapHost.current, style: mapStyleRef.current, center: [4.8897, 52.3731], zoom: 3, attributionControl: { compact: true } });
    } catch (e) {
      // maplibre throws "Failed to initialize WebGL" when no context can be created.
      console.warn('[sunvisionai] upload map', e);
      setMapFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({}), 'top-right');
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __wizMap?: maplibregl.Map }).__wizMap = map;
    // Our sources/layers are part of the style, so they are (re)added on every style load: the first
    // one and each theme switch (setStyle drops them). The data effects re-run on styleRev.
    const addOverlays = () => {
      const pal = paletteRef.current;
      if (!map.getSource('b')) map.addSource('b', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer('b-fill')) map.addLayer({ id: 'b-fill', type: 'fill', source: 'b', paint: { 'fill-color': ['case', ['==', ['get', 'sel'], true], pal.selFill, pal.footprint], 'fill-opacity': ['case', ['==', ['get', 'sel'], true], pal.selFillOpacity, 0.14] } });
      if (!map.getLayer('b-line')) map.addLayer({ id: 'b-line', type: 'line', source: 'b', paint: { 'line-color': ['case', ['==', ['get', 'sel'], true], pal.selLine, pal.footprint], 'line-width': ['case', ['==', ['get', 'sel'], true], 2, 1] } });
      if (!map.getSource('aim')) map.addSource('aim', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer('aim')) map.addLayer({ id: 'aim', type: 'line', source: 'aim', paint: { 'line-color': pal.camera, 'line-width': 2, 'line-dasharray': [2, 1] } });
      setMapReady(true);
      setStyleRev((r) => r + 1);
    };
    map.on('style.load', addOverlays);
    map.on('zoomend', () => setZoom(map.getZoom()));
    // One click handler for every mode, so a click does exactly one thing: the aim click that
    // switches to 'building' never also picks a building (modeRef only changes on the next
    // render), and picking does not depend on the footprint layer having rendered yet.
    map.on('click', (e) => {
      if (drawingRef.current) return; // FootprintDraw takes the clicks
      // A click on the camera dot (not a drag) is not a map click.
      const tgt = e.originalEvent?.target;
      if (tgt instanceof Node && camMarker.current?.getElement().contains(tgt)) return;
      const ll = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      const m = modeRef.current;
      if (m === 'camera') {
        setCam(ll);
        setCamProv('manual');
        setMode('aim');
      } else if (m === 'aim' && camRef.current) {
        const d = lonLatToEnu(camRef.current, ll);
        if (Math.hypot(d[0], d[1]) < 0.5) return; // no direction from a click on the camera itself
        setHeading(bearingOf(d[0], d[1]));
        setHeadingProv('manual');
        setMode('building');
      } else if (m === 'building') {
        pickAtRef.current(ll);
      }
    });
    // Pointer cursor over a footprint while picking.
    map.on('mousemove', (e) => {
      if (drawingRef.current) return;
      let hit = false;
      if (modeRef.current === 'building' && map.getLayer('b-fill')) {
        try {
          hit = map.queryRenderedFeatures(e.point, { layers: ['b-fill'] }).length > 0;
        } catch {
          /* style reloading */
        }
      }
      map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // The camera dot follows the theme palette too.
  useEffect(() => {
    const el = camMarker.current?.getElement();
    if (!el) return;
    el.style.background = palette.camera;
    el.style.boxShadow = `0 0 0 2px ${palette.halo}, 0 1px 4px rgb(0 0 0 / 0.45)`;
  }, [palette, cam]);

  // Theme switch: swap the basemap (dark ↔ positron); addOverlays restores our layers on style.load.
  useEffect(() => {
    if (mapStyleRef.current === mapStyle) return;
    mapStyleRef.current = mapStyle;
    const map = mapRef.current;
    if (!map) return;
    try {
      // diff:false forces a full reload so 'style.load' fires; a diffed swap would drop our layers silently.
      map.setStyle(mapStyle, { diff: false });
    } catch (e) {
      console.warn('map style', e);
    }
  }, [mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cam) return;
    if (!camMarker.current) {
      const el = document.createElement('div');
      // 16px dot with a 44px invisible grab area for fingers.
      el.className = "relative h-4 w-4 rounded-full cursor-grab before:absolute before:-inset-3.5 before:content-['']";
      el.style.background = paletteRef.current.camera;
      el.style.boxShadow = `0 0 0 2px ${paletteRef.current.halo}, 0 1px 4px rgb(0 0 0 / 0.45)`;
      el.setAttribute('aria-label', 'Camera position (drag to move)');
      camMarker.current = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([cam.lon, cam.lat]).addTo(map);
      camMarker.current.on('dragend', () => {
        const p = camMarker.current!.getLngLat();
        setCam({ lat: p.lat, lon: p.lng });
        setCamProv('manual');
      });
    } else camMarker.current.setLngLat([cam.lon, cam.lat]);
    if (map.getZoom() < 15) map.flyTo({ center: [cam.lon, cam.lat], zoom: 18 });
  }, [cam]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('aim') as maplibregl.GeoJSONSource | undefined;
    if (!src || !cam || heading == null) return;
    const h = (heading * Math.PI) / 180;
    const r = 0.0006;
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[cam.lon, cam.lat], [cam.lon + (Math.sin(h) * r) / Math.cos((cam.lat * Math.PI) / 180), cam.lat + Math.cos(h) * r]] } });
  }, [cam, heading, mapReady, styleRev]);

  // ---- buildings from the map tiles --------------------------------------------------------------
  const applyFrame = (f: WizardFrame, targetId: string | null) => {
    frameRef.current = f;
    targetRef.current = targetId;
    setFrame(f);
    setTarget(targetId);
  };
  const selectTarget = (id: string) => {
    targetRef.current = id;
    setTarget(id);
    setPickState(null);
  };

  /** Read the footprints of the whole visible map (the map centre ± half its diagonal). */
  const loadSeq = useRef(0);
  const loadFrame = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getZoom() < MIN_QUERY_ZOOM) {
      // z13 tiles only hold merged blocks: keep the last read until the user zooms in.
      setFrameLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    const c = map.getCenter();
    const origin = { lat: c.lat, lon: c.lng };
    setFrameLoading(true);
    try {
      const load = await loadFootprintsFromMap(map, origin, viewRadius(map), { waitMs: 4000 });
      if (seq !== loadSeq.current) return;
      const next = carryTarget(frameRef.current, targetRef.current, { origin, footprints: load.footprints, streets: load.streets, warnings: load.warnings });
      applyFrame(next.frame, next.targetId);
      setFrameErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // Usually the style is still (re)loading; the next style.load / moveend reads again.
      setFrameErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setFrameLoading(false);
    }
    // A click that waited for this read (the map was zooming in to it).
    const p = pendingPick.current;
    if (p && seq === loadSeq.current) {
      pendingPick.current = null;
      pickAtRef.current(p);
    }
  }, []);

  // Footprints are read once the camera is placed (they also help aiming), again after every map
  // move, camera drag and theme switch (styleRev), and on demand when a click finds nothing.
  const wantFrame = mapReady && !!cam && mode !== 'camera';
  const [reloadRev, setReloadRev] = useState(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !wantFrame) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(t);
      t = setTimeout(() => void loadFrame(), 250);
    };
    map.on('moveend', schedule);
    schedule();
    return () => {
      clearTimeout(t);
      map.off('moveend', schedule);
    };
  }, [wantFrame, cam, styleRev, reloadRev, loadFrame]);

  /** Building mode: select the footprint under `ll`, reading the tiles there if needed. */
  const pickSeq = useRef(0);
  const pickAt = async (ll: LatLon) => {
    const map = mapRef.current;
    if (!map) return;
    const seq = ++pickSeq.current;
    const tol = 3 * metersPerPixel(ll.lat, map.getZoom());
    const f = frameRef.current;
    const hit = f ? footprintAt(f, ll, tol) : null;
    if (hit) return selectTarget(hit);
    if (map.getZoom() < MIN_QUERY_ZOOM) {
      // Too far out for building tiles: zoom in on the click, then pick when the read is done.
      pendingPick.current = ll;
      setPickState('zooming');
      map.flyTo({ center: [ll.lon, ll.lat], zoom: 18 });
      return;
    }
    // Not in the last read (tiles still loading, or the read lags a map move): read right here.
    setPickState('reading');
    try {
      const load = await loadFootprintsFromMap(map, ll, PICK_RADIUS, { waitMs: 4000 });
      if (seq !== pickSeq.current) return;
      const local: WizardFrame = { origin: ll, footprints: load.footprints, streets: load.streets, warnings: load.warnings };
      const id = footprintAt(local, ll, tol);
      if (!id) {
        setPickState('miss');
        return;
      }
      applyFrame(mergeFrames(frameRef.current, local, id), id);
      setPickState(null);
    } catch (e) {
      if (seq !== pickSeq.current) return;
      setFrameErr(e instanceof Error ? e.message : String(e));
      setPickState('miss');
    }
  };
  pickAtRef.current = (ll) => void pickAt(ll);

  /** A building outlined by hand (FootprintDraw): it replaces whatever the tiles have there. */
  const onDrawn = (corners: LatLon[]) => {
    setDrawing(false);
    const base = frameRef.current;
    const c = mapRef.current?.getCenter();
    const origin = base?.origin ?? camRef.current ?? (c ? { lat: c.lat, lon: c.lng } : corners[0]);
    try {
      const fp = footprintFromCorners(corners, origin);
      const drawn: WizardFrame = { origin, footprints: [fp], streets: [], warnings: [] };
      applyFrame(mergeFrames(base, drawn, fp.id), fp.id);
      setPickState(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (mode !== 'building') {
      setDrawing(false);
      setPickState(null);
      pendingPick.current = null;
    }
  }, [mode]);

  // Draw the footprints; the selected one is highlighted ('sel').
  useEffect(() => {
    const src = mapRef.current?.getSource('b') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(frameFeatures(frame, target));
  }, [frame, target, mapReady, styleRev]);

  // Optional Overpass enrichment for the picked building, started in the background (debounced).
  const startOsm = (ll: LatLon) => {
    const key = `${ll.lat.toFixed(4)},${ll.lon.toFixed(4)}`;
    if (osmJob.current?.key === key) return osmJob.current;
    osmJob.current?.ctl.abort();
    const ctl = new AbortController();
    const p = fetchOsmAround(ll, 200, ctl.signal)
      .then((v) => (v.length ? v : null))
      .catch(() => null);
    osmJob.current = { key, started: Date.now(), ctl, p };
    return osmJob.current;
  };
  const targetLL = (f: WizardFrame | null, id: string | null): LatLon | null => {
    const fp = f && id ? f.footprints.find((x) => x.id === id) : undefined;
    return f && fp ? enuToLonLat(f.origin, ringCentroid(fp.ring)) : null;
  };
  useEffect(() => {
    if (!target) return;
    const t = setTimeout(() => {
      const ll = targetLL(frameRef.current, targetRef.current);
      if (ll) startOsm(ll);
    }, 800);
    return () => clearTimeout(t);
  }, [target]);

  // ---- photo ------------------------------------------------------------------------------------
  const onFile = async (f: File) => {
    setErr(null);
    if (!TYPES.includes(f.type)) return setErr('Please choose a JPG, PNG or WebP photograph.');
    if (f.size > MAX_BYTES) return setErr('Photo is larger than 15 MB.');
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return setErr('This file could not be decoded as an image.');
    }
    let ex: Record<string, unknown> = {};
    try {
      ex = (await exifr.parse(f, { gps: true, tiff: true, exif: true, translateValues: true })) ?? {};
    } catch {
      /* no EXIF */
    }
    const p: Photo = {
      file: f,
      url,
      width: img.naturalWidth,
      height: img.naturalHeight,
      gps: typeof ex.latitude === 'number' && typeof ex.longitude === 'number' && Number.isFinite(ex.latitude) && Number.isFinite(ex.longitude) && !(ex.latitude === 0 && ex.longitude === 0) ? { lat: ex.latitude as number, lon: ex.longitude as number } : undefined,
      heading: typeof ex.GPSImgDirection === 'number' && Number.isFinite(ex.GPSImgDirection) ? (ex.GPSImgDirection as number) : undefined,
      headingRef: typeof ex.GPSImgDirectionRef === 'string' ? (ex.GPSImgDirectionRef.toUpperCase().startsWith('M') ? 'M' : 'T') : undefined,
      focal35: typeof ex.FocalLengthIn35mmFormat === 'number' ? (ex.FocalLengthIn35mmFormat as number) : undefined,
      focalMm: typeof ex.FocalLength === 'number' ? (ex.FocalLength as number) : undefined,
      captureTime: ex.DateTimeOriginal ? String(ex.DateTimeOriginal) : undefined,
      make: ex.Make as string | undefined,
      model: ex.Model as string | undefined,
    };
    setPhoto(p);
    if (p.gps) {
      setCam(p.gps);
      setCamProv('observed');
      if (p.heading != null) {
        setHeading(p.heading);
        setHeadingProv('observed');
        setMode('building');
      } else setMode('aim');
    }
  };

  const doSearch = async () => {
    if (q.trim().length < 3) return;
    try {
      setResults(await geocode(q.trim()));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const canAnalyze = !!(photo && cam && heading != null && target && frame?.footprints.some((f) => f.id === target));

  const finishRef = useRef<(useCv: boolean) => void>(() => {});
  /**
   * Ask for the key with this wizard as the context: saving it re-runs the analysis once (as the
   * label "Add key & analyze" promises), and "Mark windows by hand instead" builds without it.
   */
  const askKeyThenRetry = (code: string) => {
    keyRetryOff.current?.();
    const off = subscribeRoboflowKeySaved(() => {
      off();
      keyRetryOff.current = null;
      if (hasRoboflowKey()) void finishRef.current(true);
    });
    keyRetryOff.current = off;
    askForKey(code, {
      notice: false,
      autoRetry: true,
      onManual: () => {
        keyRetryOff.current?.();
        keyRetryOff.current = null;
        void finishRef.current(false);
      },
    });
  };

  const finish = async (useCv: boolean) => {
    const pickFrame = frameRef.current;
    const pickTarget = targetRef.current;
    if (!photo || !cam || heading == null || !pickTarget || !pickFrame?.footprints.some((f) => f.id === pickTarget)) return;
    setErr(null);
    setKeyHelps(false);
    // Hosted inference without any usable key: ask for one instead of failing (the demo's premise).
    // Read the key now, not from this render: a just-saved key re-runs this before React re-renders.
    const gateNow = detectionCheck(healthChecked ? apiHealth : undefined, hasRoboflowKey());
    if (useCv && provider === 'hosted' && gateNow.gate === 'ask-key') {
      askKeyThenRetry(gateNow.code ?? 'shared_key_unavailable');
      return;
    }
    // Optional Overpass enrichment, running alongside the analysis (usually started when the
    // building was picked); awaited for at most OVERPASS_BUDGET_MS from its start.
    const osmLL = targetLL(pickFrame, pickTarget);
    const osmRun = osmLL ? startOsm(osmLL) : null;
    let analysis: FacadeAnalysis = { model: { provider: 'manual', modelId: 'manual-annotation' }, imageWidth: photo.width, imageHeight: photo.height, detections: [], floorRows: [], warnings: ['No computer-vision analysis: add windows with the “+ Window” tool and correct the height manually.'], pipelineVersion: 'manual' };
    if (useCv) {
      setBusy('Analyzing the photograph with Roboflow RF-DETR…');
      try {
        // analyzePhoto attaches the user's key, maps our API's error codes, opens the key dialog
        // when a key would help and refreshes the shared allowance.
        analysis = await analyzePhoto(photo.file, { provider, depth: true });
        if (!analysis.detections.some((d) => d.cls === 'window' || d.cls === 'facade'))
          analysis.warnings.push('The model found no facade or windows in this photo. You can annotate windows manually — sunvisionai will not invent geometry.');
      } catch (e) {
        setBusy(null);
        const text = e instanceof AnalyzeError ? noticeForError(e).text : (e as Error).message;
        const chk = e instanceof AnalyzeError ? detectionCheck(apiHealth, userKey, e) : null;
        const helps = chk?.gate === 'ask-key';
        setKeyHelps(helps);
        // A key is what's missing: ask for it (analyzePhoto may already have opened the dialog).
        if (helps && chk?.code) askKeyThenRetry(chk.code);
        setErr(`${text} ${helps ? 'Add your own free Roboflow key and analyse again, or continue' : 'You can continue'} with manual annotation instead.`);
        return;
      }
    }
    try {
      // Neighbours for shadows: re-read the tiles SCENE_RADIUS around the picked building (the map
      // jumps there when that circle is not on screen). Falls back to the picking read.
      setBusy('Reading the neighbouring buildings from the map…');
      let sceneFrame = pickFrame;
      let sceneTarget = pickTarget;
      const map = mapRef.current;
      const tLL = targetLL(pickFrame, pickTarget);
      if (map && tLL) {
        try {
          if (!radiusOnScreen(map, tLL, SCENE_RADIUS)) showRadius(map, tLL, SCENE_RADIUS);
          const load = await loadFootprintsFromMap(map, tLL, SCENE_RADIUS, { waitMs: 6000 });
          if (load.footprints.length) {
            const c = carryTarget(pickFrame, pickTarget, { origin: tLL, footprints: load.footprints, streets: load.streets, warnings: load.warnings });
            if (c.targetId) {
              sceneFrame = c.frame;
              sceneTarget = c.targetId;
            }
          }
        } catch {
          /* keep the picking read */
        }
      }
      let osm: OsmElement[] | null = null;
      if (osmRun) {
        setBusy(`Adding OpenStreetMap details (trees, height tags; up to ${Math.round(OVERPASS_BUDGET_MS / 1000)} s)…`);
        const r = await timeBoxed(osmRun.p, osmRun.started + OVERPASS_BUDGET_MS - Date.now());
        osm = r?.value ?? null;
        if (!r) {
          // Out of budget: stop waiting; a later build starts a fresh request.
          osmRun.ctl.abort();
          if (osmJob.current === osmRun) osmJob.current = null;
        }
      }
      const exif: NonNullable<ImageInfo['exif']> = {};
      if (photo.gps) exif.gps = photo.gps;
      if (photo.focal35) exif.focalLength35mm = photo.focal35;
      if (photo.focalMm) exif.focalLengthMm = photo.focalMm;
      if (photo.heading != null) exif.heading = photo.heading;
      if (photo.captureTime) exif.captureTime = photo.captureTime;
      if (photo.make) exif.make = photo.make;
      if (photo.model) exif.model = photo.model;
      const input: TileSceneInput = {
        id: 'upload-' + Date.now(),
        title: photo.file.name,
        image: { url: photo.url, width: photo.width, height: photo.height, exif },
        analysis,
        frameOrigin: sceneFrame.origin,
        footprints: sceneFrame.footprints,
        streets: sceneFrame.streets,
        targetId: sceneTarget,
        // The user's own camera: 'manual' (placed / clicked on the map) or 'observed' (EXIF).
        camera: wizardCamera(sceneFrame.origin, { camera: cam, heading, positionProv: camProv, headingProv, headingRef: photo.headingRef }),
        osm,
      };
      const { scene } = prepareTileScene(input);
      setBusy(null);
      loadScene(scene);
      if (!osm) set({ notice: { kind: 'info', text: 'Trees and street data unavailable. Buildings come from map tiles.' } });
    } catch (e) {
      setBusy(null);
      setErr((e as Error).message);
    }
  };

  finishRef.current = finish;

  const hostedPrivacy = provider === 'hosted';
  // Automatic detection needs a Roboflow key: the server's shared one (with allowance left) or the user's.
  const keyGate = detectionCheck(healthChecked ? apiHealth : undefined, userKey);
  const needsKey = keyGate.gate === 'ask-key';
  const sharedExhausted = keyGate.code === 'shared_quota_exhausted' || !!sharedQuota?.exhausted;
  const steps = useMemo(
    () => [
      { n: 1, label: 'Photo', done: !!photo },
      { n: 2, label: 'Camera position', done: !!cam },
      { n: 3, label: 'Viewing direction', done: heading != null },
      { n: 4, label: 'Building', done: !!target },
    ],
    [photo, cam, heading, target],
  );
  const buildingHint = (() => {
    if (drawing) return 'Outline the building: click its 4 corners on the map.';
    if (pickState === 'zooming') return 'Zooming in to read the buildings…';
    if (pickState === 'reading') return 'Reading the buildings at that spot from the map…';
    if (zoom < MIN_QUERY_ZOOM) return 'Zoom in (or click the map) to see the buildings.';
    if (!frame && frameLoading) return 'Reading buildings from the map…';
    if (!frame && frameErr) return 'The buildings could not be read from the map yet. Use “Load buildings” to try again, or draw the outline.';
    if (frame && !frame.footprints.length && !frameLoading) return 'No buildings in the map data here. Draw the outline instead.';
    return 'Click the photographed building’s footprint. Drag the green dot to refine the camera.';
  })();

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-3">
        <button type="button" className="flex min-h-7 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11" onClick={() => set({ route: { name: 'landing' } })} aria-label="sunvisionai home">
          <Wordmark size="sm" />
        </button>
        <div className="h-4 w-px bg-ink-700" />
        <ol className="flex items-center gap-1.5 text-xs sm:gap-2" aria-label="Steps">
          {steps.map((s, i) => {
            const current = !s.done && steps.slice(0, i).every((p) => p.done);
            return (
              <li key={s.n} className={clsx('flex items-center gap-1.5', s.done || current ? 'text-paper' : 'text-ink-400')}>
                {i > 0 && <span aria-hidden className="mr-0.5 hidden h-px w-3 bg-ink-600 sm:block" />}
                <span
                  aria-hidden
                  className={clsx(
                    'num grid h-5 w-5 place-items-center rounded-md text-[11px] font-semibold',
                    s.done ? 'bg-accent text-on-accent' : current ? 'text-paper ring-1 ring-inset ring-accent' : 'bg-ink-800 text-ink-300',
                  )}
                >
                  {s.done ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.25 5.25 4.25 7.25 7.75 3" />
                    </svg>
                  ) : (
                    s.n
                  )}
                </span>
                <span className={clsx('sr-only sm:not-sr-only', (s.done || current) && 'font-medium')}>{s.label}</span>
                {s.done && <span className="sr-only"> (done)</span>}
              </li>
            );
          })}
        </ol>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="relative min-h-[360px] overflow-hidden bg-ink-950 sm:min-h-[420px]">
          <div ref={mapHost} style={{ position: 'absolute', inset: 0 }} />
          {mapFailed && (
            <div role="alert" className="canvas-dots absolute inset-0 z-10 grid place-items-center p-6">
              <div className="max-w-sm space-y-2">
                <p className="text-[13px] font-semibold text-paper">The map can’t start on this device.</p>
                <p className="text-xs text-ink-300">Placing the camera needs WebGL, which this browser has turned off or can’t provide. Try another browser or device, or try an example.</p>
                <button type="button" className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11" onClick={() => set({ route: { name: 'landing' } })}>
                  Back to the start
                </button>
              </div>
            </div>
          )}
          <div className="absolute left-3 top-3 w-[min(420px,calc(100%-5rem))]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                doSearch();
              }}
              className="flex gap-1 rounded-xl bg-ink-900 p-1 shadow-panel"
            >
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an address or city…" className="h-7 min-w-0 flex-1 rounded-md bg-ink-800 px-2 text-base text-paper placeholder:text-ink-400 focus:outline-1 focus:outline-accent sm:text-xs pointer-coarse:h-11" aria-label="Search address" />
              <button type="submit" className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-paper hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11">Search</button>
            </form>
            {results.length > 0 && (
              <ul className="mt-1 overflow-hidden rounded-lg bg-ink-900 p-1 text-xs shadow-panel">
                {results.map((r, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full truncate rounded-md px-2 py-1.5 text-left text-ink-200 hover:bg-ink-800 hover:text-paper focus-visible:bg-selected focus-visible:outline-none pointer-coarse:min-h-11"
                      onClick={() => {
                        mapRef.current?.flyTo({ center: [r.lon, r.lat], zoom: 18 });
                        setResults([]);
                      }}
                    >
                      {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 overflow-hidden rounded-xl bg-ink-900 text-xs text-ink-200 shadow-panel" aria-live="polite">
              <div className="px-3 py-2.5">
              {mode === 'camera' && 'Click the map where the photo was taken (the camera position, not the building).'}
              {mode === 'aim' && 'Now click the building the camera was pointing at to set the viewing direction.'}
              {mode === 'building' && buildingHint}
              {mode === 'building' && pickState === 'miss' && !drawing && (
                <p className="mt-1 font-medium text-paper" role="status">
                  No building on the map at that spot. Click inside a footprint, or draw the outline if the building is missing.
                </p>
              )}
              </div>
              <div className="flex flex-wrap gap-0.5 border-t border-ink-700 p-1 pointer-coarse:[&_button]:min-h-11">
                <Btn active={mode === 'camera'} onClick={() => setMode('camera')}>Place camera</Btn>
                <Btn active={mode === 'aim'} onClick={() => setMode('aim')} disabled={!cam}>Set direction</Btn>
                <Btn active={mode === 'building'} onClick={() => setMode('building')} disabled={!cam}>Pick building</Btn>
                {cam && mode !== 'camera' && (
                  <Btn onClick={() => setReloadRev((r) => r + 1)} disabled={frameLoading} title="Read the buildings of the visible map again">{frame ? 'Reload buildings' : 'Load buildings'}</Btn>
                )}
                {mode === 'building' && mapReady && !mapFailed && (
                  <Btn active={drawing} onClick={() => setDrawing((d) => !d)} title="Outline a building that is missing from the map by clicking its 4 corners">{drawing ? 'Stop drawing' : 'Not on the map? Draw it'}</Btn>
                )}
              </div>
            </div>
          </div>
          {drawing && mapReady && mapRef.current && <FootprintDraw map={mapRef.current} onDone={onDrawn} onCancel={() => setDrawing(false)} />}
          <div className="pointer-events-none absolute bottom-6 left-3 max-w-[calc(100%-1.5rem)] rounded-sm bg-ink-900/85 px-1.5 py-0.5 text-[11px] text-ink-400">Geocoding: Nominatim · Buildings: OpenStreetMap (ODbL) via OpenFreeMap tiles · Details: Overpass API when it answers</div>
        </section>

        <aside className="flex min-h-0 flex-col overflow-y-auto border-t border-ink-700 bg-ink-900 lg:border-l lg:border-t-0">
          <div className="border-b border-ink-700 px-4 py-3">
          {!photo ? (
            <label
              className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-600 px-4 text-center text-xs text-ink-300 transition-colors duration-150 focus-within:outline-2 focus-within:outline-accent hover:border-accent hover:bg-selected hover:text-paper"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) onFile(f);
              }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mb-1 text-ink-400">
                <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
                <path d="m2.75 13.5 4-4 3.5 3.5 2.25-2.25 4.75 4.75" />
                <circle cx="13" cy="7.75" r="1.25" />
              </svg>
              <span className="text-[13px] font-semibold text-paper">Drop a street photograph</span>
              <span>or click to choose · JPG, PNG, WebP · max 15 MB</span>
              <span className="max-w-[300px] text-[11px] text-ink-400">Your photo stays in this browser until you choose to analyze it. EXIF location is read locally.</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
          ) : (
            <div>
              <img src={photo.url} alt="Uploaded" className="w-full rounded-lg ring-1 ring-ink-700" />
              <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-[11px] leading-4">
                <dt className="text-ink-400">Size</dt><dd className="num text-right">{photo.width}×{photo.height}</dd>
                <dt className="text-ink-400">GPS</dt><dd className="text-right">{photo.gps ? <><span className="num">{photo.gps.lat.toFixed(5)}, {photo.gps.lon.toFixed(5)}</span> <Prov p="observed" /></> : <span className="text-ink-400">none — place on map</span>}</dd>
                <dt className="text-ink-400">Heading</dt><dd className="text-right">{heading != null ? <><span className="num">{heading.toFixed(0)}°</span> <Prov p={headingProv} /></> : <span className="text-ink-400">not set</span>}</dd>
                <dt className="text-ink-400">Focal (35 mm eq.)</dt><dd className="text-right">{photo.focal35 ? <><span className="num">{photo.focal35} mm</span> <Prov p="observed" /></> : <span className="text-ink-400">unknown — 60° FOV assumed</span>}</dd>
                {photo.make && <><dt className="text-ink-400">Camera</dt><dd className="truncate text-right">{photo.make} {photo.model}</dd></>}
              </dl>
              <Btn className="-ml-2 mt-2" onClick={() => setPhoto(null)}>Choose another photo</Btn>
            </div>
          )}
          </div>

          <div className="border-b border-ink-700 px-4 pb-3 text-xs">
            <h2 className="flex h-8 items-center text-[11px] font-semibold text-paper">Analysis</h2>
            {!healthChecked ? (
              <p className="text-ink-400">Checking the sunvisionai analysis server…</p>
            ) : health ? (
              <>
                <p className="text-ink-300">
                  Analysis server connected. Facade model via {health.providers.local ? 'Roboflow Inference on that server or ' : ''}Roboflow hosted inference
                  {userKey ? ' (with your own key)' : health.apiKeyConfigured ? (sharedExhausted ? ' (the shared allowance is used up)' : ' (shared demo key)') : ' (no shared key on this server)'}.
                </p>
                {needsKey && (
                  <div className="mt-2 rounded-lg bg-selected p-3">
                    <p className="text-xs text-paper">
                      {sharedExhausted ? "This demo's shared Roboflow allowance is used up." : 'This server has no shared Roboflow key.'} Automatic window detection needs a key: add your own free Roboflow key to run it.
                    </p>
                    <button type="button" onClick={() => askForKey(keyGate.code ?? 'shared_key_unavailable', { notice: false, autoRetry: false, onManual: undefined })} className="mt-2 inline-flex h-7 items-center rounded-md bg-ink-900 px-2.5 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11">
                      Add a Roboflow key
                    </button>
                  </div>
                )}
                <div className="mt-2.5 inline-flex gap-0.5 rounded-md bg-ink-800 p-0.5">
                  <Btn active={provider === 'hosted'} onClick={() => setProvider('hosted')} title={needsKey ? "Roboflow's hosted inference API (needs a Roboflow key)" : "Roboflow's hosted inference API"}>Hosted</Btn>
                  <Btn active={provider === 'local'} onClick={() => setProvider('local')} disabled={!health.providers.local} title="Roboflow Inference running on the sunvisionai analysis server: the photo is not sent to Roboflow">On the server</Btn>
                </div>
                <p className="mt-2.5 text-[11px] leading-4 text-ink-400">
                  Privacy: the photo is uploaded to the sunvisionai analysis server, which removes its metadata (EXIF, including GPS), runs depth estimation
                  {hostedPrivacy ? ' and forwards a copy of at most 2048 px to Roboflow’s inference API' : ''}. The server does not store it.
                </p>
              </>
            ) : (
              <p className="text-ink-400">No analysis server detected (<span className="num">/api</span>). To run one yourself, start it with <code className="num text-ink-200">uv run uvicorn sunvision_cv.app:app</code>, or continue with manual annotation.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5 pointer-coarse:[&_button]:min-h-11">
              <Btn kind="primary" disabled={!canAnalyze || !health || !!busy} onClick={() => finish(true)} title={needsKey && provider === 'hosted' ? 'Asks for your Roboflow key first' : undefined}>
                {needsKey && provider === 'hosted' ? 'Add key & analyze' : 'Analyze & build twin'}
              </Btn>
              <Btn kind="solid" disabled={!canAnalyze || !!busy} onClick={() => finish(false)}>Continue with manual annotation</Btn>
            </div>
            {!canAnalyze && <p className="mt-2 text-[11px] text-ink-400">Complete the steps: photo, camera position, viewing direction, building.</p>}
          </div>
          {(busy || err || target) && (
          <div className="space-y-2 px-4 py-3">
          {busy && (
            <p className="flex items-center gap-2 text-xs text-paper" role="status">
              <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-600 border-t-accent motion-reduce:animate-none" />
              {busy}
            </p>
          )}
          {err && (
            <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger-text ring-1 ring-inset ring-danger/25" role="alert">
              <p>{err}</p>
              {keyHelps && (
                <button type="button" onClick={() => set({ keyDialogOpen: true })} className="mt-2 inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-paper ring-1 ring-inset ring-ink-700 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11">
                  Add a Roboflow key
                </button>
              )}
            </div>
          )}
          {target && (
            <p className="text-[11px] text-ink-400">
              Selected footprint:{' '}
              {osmLink(target) ? (
                <a className="num text-accent-300 hover:underline" href={osmLink(target)!} target="_blank" rel="noreferrer">{target}</a>
              ) : target.startsWith('user/') ? (
                <span className="text-ink-200">outline drawn by you</span>
              ) : (
                <span className="text-ink-200">OpenStreetMap building from the map tiles</span>
              )}
            </p>
          )}
          </div>
          )}
        </aside>
      </div>
    </div>
  );
}
