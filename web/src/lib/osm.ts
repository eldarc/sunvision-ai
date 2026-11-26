/**
 * Browser-side OpenStreetMap access for the upload flow.
 * Respects public service etiquette: one Overpass query per located photo,
 * debounced geocoding, explicit attribution. Endpoints are configurable.
 */
import type { LatLon } from '../schema/scene';

export const OVERPASS_URL = (import.meta.env.VITE_OVERPASS_URL as string | undefined) ?? 'https://overpass-api.de/api/interpreter';
/** Public mirrors tried in order when the primary instance is slow or rate-limited. */
export const OVERPASS_MIRRORS = [OVERPASS_URL, 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'].filter((v, i, a) => a.indexOf(v) === i);
export const GEOCODER_URL = (import.meta.env.VITE_GEOCODER_URL as string | undefined) ?? 'https://nominatim.openstreetmap.org/search';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

// Cache per ~10 m cell so repeated attempts don't hit the public servers again.
const memCache = new Map<string, OsmElement[]>();
const cacheKey = (c: LatLon, r: number) => `osm2:${c.lat.toFixed(4)},${c.lon.toFixed(4)},${r}`;

export async function fetchOsmAround(c: LatLon, radius = 200, signal?: AbortSignal, onProgress?: (host: string) => void): Promise<OsmElement[]> {
  const key = cacheKey(c, radius);
  const hit = memCache.get(key);
  if (hit) return hit;
  try {
    const ss = sessionStorage.getItem(key);
    if (ss) {
      const v = JSON.parse(ss) as OsmElement[];
      memCache.set(key, v);
      return v;
    }
  } catch {
    /* storage unavailable */
  }
  const els = (await bundledSnapshot(c, onProgress)) ?? (await fetchOsmUncached(c, radius, signal, onProgress));
  memCache.set(key, els);
  try {
    sessionStorage.setItem(key, JSON.stringify(els));
  } catch {
    /* quota / unavailable */
  }
  return els;
}

/**
 * Curated examples ship the OSM snapshot they were built from (ODbL). Near one of them we reuse it
 * instead of querying the public Overpass servers again.
 */
async function bundledSnapshot(c: LatLon, onProgress?: (host: string) => void): Promise<OsmElement[] | null> {
  try {
    const idx = (await (await fetch('examples/index.json')).json()) as { id: string; center?: LatLon; osmSnapshot?: string }[];
    for (const e of idx) {
      if (!e.center || !e.osmSnapshot) continue;
      const dy = (e.center.lat - c.lat) * 111320;
      const dx = (e.center.lon - c.lon) * 111320 * Math.cos((c.lat * Math.PI) / 180);
      if (Math.hypot(dx, dy) > 120) continue;
      onProgress?.(`bundled snapshot (${e.id})`);
      const r = await fetch(`examples/${e.id}/${e.osmSnapshot}`);
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      return ((await r.json()) as { elements: OsmElement[] }).elements;
    }
  } catch {
    /* fall through to the network */
  }
  return null;
}

async function fetchOsmUncached(c: LatLon, radius: number, signal?: AbortSignal, onProgress?: (host: string) => void): Promise<OsmElement[]> {
  const q = `[out:json][timeout:25];
(
  way["building"](around:${radius},${c.lat},${c.lon});
  relation["building"]["type"="multipolygon"](around:${radius},${c.lat},${c.lon});
  way["building:part"](around:${Math.min(radius, 120)},${c.lat},${c.lon});
  node["natural"="tree"](around:${radius},${c.lat},${c.lon});
  way["highway"](around:${radius},${c.lat},${c.lon});
);
out geom;`;
  let lastErr = 'unknown error';
  for (const url of OVERPASS_MIRRORS) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      onProgress?.(new URL(url).host);
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal });
      if (r.status === 429 || r.status === 504) {
        lastErr = `${new URL(url).host} busy (HTTP ${r.status})`;
        continue;
      }
      if (!r.ok) {
        lastErr = `${new URL(url).host} error (HTTP ${r.status})`;
        continue;
      }
      const j = await r.json();
      return j.elements as OsmElement[];
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = `${new URL(url).host} timed out`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(`Could not load OpenStreetMap buildings (${lastErr}). Public Overpass servers may be busy — try again in a minute.`);
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

export async function geocode(q: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const url = `${GEOCODER_URL}?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Geocoder error (HTTP ${r.status})`);
  const j = (await r.json()) as { display_name: string; lat: string; lon: string }[];
  return j.map((x) => ({ label: x.display_name, lat: Number(x.lat), lon: Number(x.lon) }));
}

export function parseHeight(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.replace(',', '.').match(/([\d.]+)\s*(m|ft|')?/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!isFinite(n) || n <= 0) return undefined;
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}
