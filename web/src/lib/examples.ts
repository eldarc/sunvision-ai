import type { FacadeAnalysis, Scene } from '../schema/scene';
import { useStore } from '../state/store';

export interface ExampleIndexEntry {
  id: string;
  title: string;
  city: string;
  country: string;
  description: string;
  thumbnail?: string;
  /** Small landing-card preview (card.webp, scripts/make_thumbs.py); falls back to thumbnail. */
  card?: string;
  credit?: string;
}

const EMPTY_ANALYSIS = (w: number, h: number): FacadeAnalysis => ({
  model: { provider: 'none', modelId: 'none' },
  imageWidth: w,
  imageHeight: h,
  detections: [],
  floorRows: [],
  warnings: ['No recorded inference for this example yet — annotate windows manually.'],
  pipelineVersion: 'n/a',
});

/** View-strip thumbnails (thumb.webp next to each bundled photo, scripts/make_thumbs.py), keyed by resolved photo URL. */
const viewThumbs = new Map<string, string>();

const prefetched = new Set<string>();
/**
 * Starts downloading an image into the HTTP cache (once per URL), so it shows at once when it is
 * displayed later. The small cards and thumbnails no longer do this as a side effect.
 */
export function prefetchImage(url: string) {
  if (!url || prefetched.has(url) || typeof Image === 'undefined') return;
  prefetched.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

/** Thumbnail URL for a resolved example photo URL, if it has one. Uploads (blob URLs) never do. */
export function viewThumbUrl(photoUrl: string): string | undefined {
  return viewThumbs.get(photoUrl);
}

const thumbFor = (photoUrl: string) => viewThumbs.set(photoUrl, photoUrl.replace(/[^/]*$/, 'thumb.webp'));

/** Fetch scene.base.json + analysis.json for a curated example and merge them. */
export async function fetchExample(id: string): Promise<Scene> {
  const base = `examples/${id}/`;
  const r = await fetch(base + 'scene.base.json');
  if (!r.ok) throw new Error(`scene.base.json: HTTP ${r.status}`);
  const scene = (await r.json()) as Omit<Scene, 'analysis'> & { analysis?: FacadeAnalysis };
  let analysis: FacadeAnalysis;
  const a = await fetch(base + 'analysis.json');
  // Dev servers / static hosts may answer a missing file with index.html (status 200).
  if (a.ok && (a.headers.get('content-type') ?? '').includes('json')) analysis = (await a.json()) as FacadeAnalysis;
  else analysis = EMPTY_ANALYSIS(scene.image.width, scene.image.height);
  // Resolve relative asset URLs against the example directory.
  const abs = (u: string) => (/^(https?:|blob:|data:|\/)/.test(u) ? u : base + u);
  scene.image = { ...scene.image, url: abs(scene.image.url) };
  if (analysis.depth) analysis = { ...analysis, depth: { ...analysis.depth, url: analysis.depth.url, binUrl: analysis.depth.binUrl } };
  // Extra views store their photo and depth paths relative to the example folder
  // (views/<viewId>/photo.jpg, views/<viewId>/depth16.bin): resolve them here, so a view's
  // depth is loaded from its URL as is (see loadDepthArray in lib/useSim.ts).
  if (scene.extraViews?.length)
    scene.extraViews = scene.extraViews.map((v) => ({
      ...v,
      image: { ...v.image, url: abs(v.image.url) },
      analysis: v.analysis.depth
        ? { ...v.analysis, depth: { ...v.analysis.depth, url: abs(v.analysis.depth.url), ...(v.analysis.depth.binUrl ? { binUrl: abs(v.analysis.depth.binUrl) } : {}) } }
        : v.analysis,
    }));
  thumbFor(scene.image.url);
  for (const v of scene.extraViews ?? []) thumbFor(v.image.url);
  return { ...(scene as Scene), analysis };
}

export async function loadExample(id: string) {
  const { set, loadScene } = useStore.getState();
  set({ loading: id, error: null });
  try {
    const scene = await fetchExample(id);
    loadScene(scene);
    // A pleasant default moment: a spring afternoon.
    const y = new Date().getFullYear();
    set({ date: `${y}-04-15`, minutes: 15 * 60 });
    history.replaceState(null, '', `#/example/${id}`);
  } catch (e) {
    set({ loading: null, error: `Could not load example “${id}”: ${(e as Error).message}` });
  }
}
