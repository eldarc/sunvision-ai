import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useStore } from '../state/store';
import { useSimContext } from './SimContext';
import { enuToLonLat, lonLatToEnu } from '../engine';
import type { Scene, Vec2 } from '../schema/scene';
import { THEME_COLORS, useResolvedTheme, useThemeColors } from '../lib/theme';

/** The dark OpenFreeMap style; theme-aware code uses `useThemeColors().mapStyle`. */
export const MAP_STYLE = THEME_COLORS.dark.mapStyle;

/** Colours of the map overlays, read from the CSS tokens of the current theme (MapLibre needs literal colours). */
export interface MapPalette {
  target: string;
  photo: string;
  osm: string;
  assumed: string;
  hypothetical: string;
  camera: string;
  selected: string;
}

const FALLBACK: Record<'light' | 'dark', MapPalette> = {
  dark: { target: '#f5b544', photo: '#c9b98f', osm: '#7d97b8', assumed: '#6b6b6b', hypothetical: '#a98bd6', camera: '#6fcf97', selected: '#0d99ff' },
  light: { target: '#a35a08', photo: '#b9a47a', osm: '#3d5f86', assumed: '#b3b3b3', hypothetical: '#83409f', camera: '#1d7547', selected: '#0b84e5' },
};

/** Reads the overlay colours from the live tokens on <html>; falls back to the built-in table. */
export function readMapPalette(theme: 'light' | 'dark'): MapPalette {
  const fb = FALLBACK[theme];
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fb;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, d: string) => {
    const x = cs.getPropertyValue(name).trim();
    return /^#[0-9a-f]{3,8}$/i.test(x) ? x : d;
  };
  return {
    target: v('--color-sun-500', fb.target),
    photo: fb.photo,
    osm: v('--color-map', fb.osm),
    assumed: v('--color-ink-500', fb.assumed),
    hypothetical: v('--color-man', fb.hypothetical),
    camera: v('--color-obs', fb.camera),
    // The selected footprint is outlined in the UI selection blue.
    selected: v('--color-accent', fb.selected),
  };
}

/** (Re)adds the sources and layers of the workspace map; idempotent, called after every style load. */
function addOverlay(map: maplibregl.Map, c: MapPalette) {
  if (!map.getSource('fp')) map.addSource('fp', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('fov')) map.addSource('fov', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getLayer('fov')) map.addLayer({ id: 'fov', type: 'fill', source: 'fov', paint: { 'fill-color': c.camera, 'fill-opacity': 0.14 } });
  if (!map.getLayer('fov-line')) map.addLayer({ id: 'fov-line', type: 'line', source: 'fov', paint: { 'line-color': c.camera, 'line-width': 1 } });
  if (!map.getLayer('fp-3d'))
    map.addLayer({
      id: 'fp-3d',
      type: 'fill-extrusion',
      source: 'fp',
      paint: {
        'fill-extrusion-color': ['match', ['get', 'kind'], 'target', c.target, 'photo', c.photo, 'hypothetical', c.hypothetical, 'map', c.osm, c.assumed],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-opacity': 0.85,
      },
    });
  if (!map.getLayer('fp-sel')) map.addLayer({ id: 'fp-sel', type: 'line', source: 'fp', filter: ['==', ['get', 'selected'], true], paint: { 'line-color': c.selected, 'line-width': 2 } });
}

function ringToLngLat(scene: Scene, ring: Vec2[]) {
  const pts = ring.map((p) => {
    const ll = enuToLonLat(scene.origin, p);
    return [ll.lon, ll.lat];
  });
  return [...pts, pts[0]];
}

function fovWedge(scene: Scene, pos: Vec2, heading: number, hfov: number, r = 60) {
  const pts: number[][] = [];
  const p0 = enuToLonLat(scene.origin, pos);
  pts.push([p0.lon, p0.lat]);
  for (let a = heading - hfov / 2; a <= heading + hfov / 2 + 0.01; a += hfov / 12) {
    const rad = (a * Math.PI) / 180;
    const ll = enuToLonLat(scene.origin, [pos[0] + Math.sin(rad) * r, pos[1] + Math.cos(rad) * r]);
    pts.push([ll.lon, ll.lat]);
  }
  pts.push([p0.lon, p0.lat]);
  return pts;
}

export default function MapPanel() {
  const scene = useStore((s) => s.scene)!;
  const camera = useStore((s) => s.camera)!;
  const selectedBuildingId = useStore((s) => s.selectedBuildingId);
  const extra = useStore((s) => s.extraBuildings);
  const set = useStore((s) => s.set);
  const setCamera = useStore((s) => s.setCamera);
  const sim = useSimContext();
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const loaded = useRef(false);
  const theme = useResolvedTheme();
  const { mapStyle } = useThemeColors();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const styleRef = useRef(mapStyle);
  const [palette, setPalette] = useState<MapPalette>(() => FALLBACK[theme]);

  useEffect(() => {
    if (!host.current) return;
    styleRef.current = mapStyle;
    const map = new maplibregl.Map({
      container: host.current,
      style: mapStyle,
      center: [scene.origin.lon, scene.origin.lat],
      zoom: 17.6,
      pitch: 45,
      bearing: camera.heading - 0,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    mapRef.current = map;
    // 'style.load' fires for the first style and again after every setStyle (theme change), which
    // drops our sources and layers: add them back, in the colours of the theme now in effect.
    map.on('style.load', () => {
      const c = readMapPalette(themeRef.current);
      addOverlay(map, c);
      setPalette(c);
      loaded.current = true;
      map.fire('sv-update' as never);
    });
    // Layer-scoped listeners are kept by the map across style swaps.
    map.on('click', 'fp-3d', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) set({ selectedBuildingId: String(id) });
    });
    map.on('mouseenter', 'fp-3d', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'fp-3d', () => (map.getCanvas().style.cursor = ''));
    const el = document.createElement('div');
    // Drag handle: a small green dot with a white rim inside a 24px hit area.
    el.className = 'grid h-6 w-6 cursor-grab place-items-center';
    const dot = document.createElement('span');
    dot.className = 'h-3.5 w-3.5 rounded-full border-2 border-knob bg-obs shadow-float';
    el.appendChild(dot);
    el.title = 'Photographer position — drag to adjust';
    const marker = new maplibregl.Marker({ element: el, draggable: true });
    const ll = enuToLonLat(scene.origin, camera.position);
    marker.setLngLat([ll.lon, ll.lat]).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      setCamera({ position: lonLatToEnu(scene.origin, { lat: p.lat, lon: p.lng }) });
    });
    markerRef.current = marker;
    return () => {
      loaded.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Theme change: swap the basemap; 'style.load' re-adds the overlay and refreshes the data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleRef.current === mapStyle) return;
    styleRef.current = mapStyle;
    loaded.current = false;
    map.setStyle(mapStyle, { diff: false });
  }, [mapStyle]);

  // data updates
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      if (!loaded.current || !sim) return;
      const feats = scene.footprints.map((fp) => {
        const m = sim.recon.buildings[fp.id];
        const kind = fp.id === scene.targetBuildingId ? 'target' : m.reconstructedFrom === 'photo' ? 'photo' : m.height.source === 'map' ? 'map' : 'assumed';
        return { type: 'Feature' as const, properties: { id: fp.id, height: sim.geo.heights[fp.id] ?? m.height.value, kind, selected: fp.id === selectedBuildingId }, geometry: { type: 'Polygon' as const, coordinates: [ringToLngLat(scene, fp.ring)] } };
      });
      for (const x of extra) feats.push({ type: 'Feature', properties: { id: x.id, height: x.height, kind: 'hypothetical', selected: false }, geometry: { type: 'Polygon', coordinates: [ringToLngLat(scene, x.ring)] } });
      (map.getSource('fp') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
      (map.getSource('fov') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [fovWedge(scene, camera.position, camera.heading, camera.hfov)] } });
      const ll = enuToLonLat(scene.origin, camera.position);
      markerRef.current?.setLngLat([ll.lon, ll.lat]);
    };
    update();
    map.on('sv-update' as never, update);
    return () => {
      map.off('sv-update' as never, update);
    };
  }, [sim, camera, selectedBuildingId, extra, scene]);

  return (
    <div className="relative h-full">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="pointer-events-none absolute bottom-8 left-2 flex flex-col gap-1 rounded-xl bg-ink-900 px-2.5 py-2 text-[11px] leading-4 text-ink-300 shadow-panel">
        {[
          [palette.target, 'Photographed building'],
          [palette.photo, 'Height from photo'],
          [palette.osm, 'Height from OSM tags'],
          [palette.assumed, 'Assumed height'],
          [palette.hypothetical, 'Hypothetical'],
          [palette.camera, 'Camera & field of view'],
        ].map(([c, l]) => (
          <span key={l} className="flex items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-xs" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}
