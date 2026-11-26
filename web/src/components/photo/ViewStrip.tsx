/**
 * ViewStrip: thumbnails of every photograph of the scene (the main photo plus
 * `scene.extraViews`) under the photo panel, and an add tile that opens AddViewDialog.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Scene } from '../../schema/scene';
import { useStore } from '../../state/store';
import { sceneViews } from '../../lib/views';
import { exampleBase } from '../../lib/useSim';
import { fetchHealth } from '../../lib/analyzeApi';

const ABSOLUTE = /^(https?:|blob:|data:|\/)/;

/**
 * Resolve an asset URL of a view against the example folder. Curated extra views store their
 * image and depth paths relative to the example directory (`views/<id>/photo.jpg`); the main
 * photo's URL is already resolved by lib/examples.ts. Already-resolved URLs are left alone.
 */
export function resolveViewAsset(scene: Scene, url: string): string {
  if (!url || ABSOLUTE.test(url)) return url;
  const base = exampleBase(scene);
  if (!base || url.startsWith(base)) return url;
  return base + url;
}

/** Base to pass to loadDepthArray() for a view's depth info (binUrl may or may not be resolved yet). */
export function depthBaseFor(scene: Scene, binUrl: string | undefined): string {
  if (!binUrl || ABSOLUTE.test(binUrl)) return '';
  const base = exampleBase(scene);
  return binUrl.startsWith(base) ? '' : base;
}

let healthOnce: Promise<boolean> | null = null;
/** Whether our CV API answers /api/health (checked once per page load). null while unknown. */
export function useApiAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    healthOnce ??= fetchHealth()
      .then((h) => h != null)
      .catch(() => false);
    healthOnce.then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

export default function ViewStrip() {
  const scene = useStore((s) => s.scene);
  const camera = useStore((s) => s.camera);
  const detections = useStore((s) => s.detections);
  const viewCameras = useStore((s) => s.viewCameras);
  const viewDetections = useStore((s) => s.viewDetections);
  const activeViewId = useStore((s) => s.activeViewId);
  const uiMode = useStore((s) => s.uiMode);
  const set = useStore((s) => s.set);
  const removeExtraView = useStore((s) => s.removeExtraView);
  const api = useApiAvailable();
  if (!scene) return null;
  const views = sceneViews(scene, { camera, detections, viewCameras, viewDetections });
  const openAdd = () => set({ addViewOpen: true });

  // Hidden when there is only the main photo, in simple mode, with no backend: a one-line link instead.
  if (views.length === 1 && uiMode === 'simple' && api === false) {
    return (
      <div className="flex min-h-8 shrink-0 items-center border-t border-ink-700 bg-ink-900 px-3 text-[11px] text-ink-300">
        <button type="button" onClick={openAdd} className="min-h-8 rounded-sm text-left font-medium text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11">
          Have a photo of the buildings opposite? Add it
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-[68px] shrink-0 items-start gap-3 overflow-x-auto border-t border-ink-700 bg-ink-900 px-3 pt-2.5" role="group" aria-label="Photos of this scene">
      {views.map((v, i) => {
        const active = v.id === activeViewId;
        const label = i === 0 ? 'Main photo' : v.label;
        return (
          <div key={v.id} className="group relative shrink-0">
            <button
              type="button"
              aria-pressed={active}
              title={label}
              onClick={() => set({ activeViewId: v.id, alignMode: false })}
              className={clsx(
                'flex flex-col items-start gap-1 rounded-md text-[11px] leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                active ? 'font-medium text-paper' : 'text-ink-400 hover:text-paper',
              )}
            >
              <img
                src={resolveViewAsset(scene, v.image.url)}
                alt=""
                width={56}
                height={42}
                loading="lazy"
                className={clsx('h-[42px] w-[56px] rounded-md bg-ink-800 object-cover transition-shadow', active ? 'ring-2 ring-accent' : 'ring-1 ring-ink-700 group-hover:ring-ink-500')}
              />
              <span className="max-w-[72px] truncate">{label}</span>
            </button>
            {i > 0 && uiMode === 'advanced' && (
              <button
                type="button"
                aria-label={`Remove photo “${label}”`}
                title="Remove this photo"
                onClick={() => removeExtraView(v.id)}
                // Touch screens have no hover: the remove button stays visible there, with a 44px hit area.
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 place-items-center rounded-sm bg-ink-900 text-ink-300 shadow-float before:absolute before:-inset-2 before:content-[''] hover:bg-danger hover:text-on-accent focus-visible:grid focus-visible:outline-2 focus-visible:outline-accent group-hover:grid pointer-coarse:grid pointer-coarse:h-7 pointer-coarse:w-7"
              >
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                  <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={openAdd}
        className="flex h-[42px] shrink-0 items-center gap-1.5 rounded-md border border-dashed border-ink-600 px-3 text-[11px] font-medium text-ink-300 transition-colors hover:border-ink-400 hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:min-h-11"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
          <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Photo of what's opposite
      </button>
    </div>
  );
}
