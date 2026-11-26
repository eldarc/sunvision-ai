/**
 * Landing: pick a curated example, watch its real recorded detections draw
 * in, click a window to land in the workspace with that window selected — or drop your
 * own photo. This module must stay light: no three.js, maplibre or Inspector imports
 * (the stage only reads fixture JSON). The only sun numbers are computed in the workspace.
 *
 * Layout: a 48px top bar, a left "panel" with the pitch, the
 * example files and the call to action, and a dotted canvas on the right where the example
 * photo sits as a frame. Below, plain hairline-separated sections (docs/DESIGN.md).
 *
 * Phones (<640px): the canvas sits on top, the picker is a horizontal snap row, and a fixed
 * bottom bar keeps "Use your own photo" in reach at all times. Colours come from tokens
 * (index.css), which swap under :root[data-theme="light"].
 */
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Btn, Wordmark } from './ui';
import { ThemeToggle } from './kit';
import { loadExample, type ExampleIndexEntry } from '../lib/examples';
import ExampleStage from './landing/ExampleStage';
import ExamplePicker from './landing/ExamplePicker';
import KeyPill from './roboflow/KeyPill';

/** Optional repository link (set VITE_REPO_URL at build time); hidden when unset. */
const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined) || null;

/** Error text token (AA in both themes). */
const DANGER_TEXT = 'text-danger-text';

const ACCEPT = 'image/jpeg,image/png,image/webp';
/** Hairline-underlined link in running text (footer). */
const TEXT_LINK = 'rounded-xs underline decoration-ink-500 underline-offset-2 hover:text-paper hover:decoration-ink-400 focus-visible:outline-2 focus-visible:outline-accent';
/** Text-only nav link in the top bar. */
const NAV_LINK = 'hidden h-7 items-center rounded-md px-2 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent sm:inline-flex';

const isPhoto = (f: File) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);

/** True when keyboard shortcuts must be ignored because the user is typing. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function Landing() {
  const set = useStore((s) => s.set);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const keyDialogOpen = useStore((s) => s.keyDialogOpen);

  const [examples, setExamples] = useState<ExampleIndexEntry[] | null>(null);
  const [idxErr, setIdxErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch('examples/index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list: ExampleIndexEntry[]) => {
        if (!alive) return;
        setExamples(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e) => alive && setIdxErr(String((e as Error).message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const selected = examples?.find((x) => x.id === selectedId) ?? null;
  const shown = examples?.find((x) => x.id === (previewId ?? selectedId)) ?? selected;
  const opening = loading ? (examples?.find((x) => x.id === loading) ?? null) : null;

  const interact = useCallback(() => setInteracted(true), []);

  /**
   * Open an example in the workspace. `selection` is 'auto' or a window id ('win-' + detection id,
   * the FacadeWindow id the workspace resolves once the reconstruction is ready).
   */
  const openExample = useCallback(
    async (id: string, selection: 'auto' | string) => {
      if (useStore.getState().loading) return;
      // Set before loading so the workspace sees it on its first render.
      set({ pendingSelection: selection });
      await loadExample(id);
      const st = useStore.getState();
      if (st.error && st.route.name !== 'workspace') set({ pendingSelection: null });
    },
    [set],
  );

  /** Route to the upload flow, handing over the file when there is one. */
  const goUpload = useCallback(
    (file?: File) => {
      if (file && !isPhoto(file)) {
        setFileErr(`“${file.name}” isn't a JPG, PNG or WebP photo.`);
        return;
      }
      setFileErr(null);
      // The dropped/browsed File rides along on the route; QuickUpload takes it once.
      set({ route: file ? { name: 'upload', file } : { name: 'upload' } });
    },
    [set],
  );

  const browse = useCallback(() => fileRef.current?.click(), []);

  // Page-level shortcuts: number keys 1–9 select the n-th example, U opens the file picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTyping(e.target) || useStore.getState().keyDialogOpen) return;
      if (/^[1-9]$/.test(e.key) && examples) {
        const ex = examples[Number(e.key) - 1];
        if (!ex) return;
        e.preventDefault();
        interact();
        setPreviewId(null);
        setSelectedId(ex.id);
      } else if (e.key === 'u' || e.key === 'U') {
        e.preventDefault();
        interact();
        browse();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [examples, interact, browse]);

  // A photo dropped anywhere on the landing goes to the upload flow.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      goUpload(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [goUpload]);

  return (
    // Bottom padding on phones keeps the last content clear of the fixed "Use your own photo" bar.
    <div className="relative min-h-full overflow-x-hidden overflow-y-auto bg-ink-900 pb-[calc(116px+env(safe-area-inset-bottom))] text-paper sm:pb-0">
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) goUpload(f);
        }}
      />

      <nav className="flex h-12 items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-4 sm:px-8" aria-label="Main">
        <div className="flex min-w-0 items-center">
          <Wordmark size="md" />
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <a href="#how" className={NAV_LINK}>
            How it works
          </a>
          {REPO_URL && (
            <a href={REPO_URL} target="_blank" rel="noreferrer" className={NAV_LINK}>
              GitHub
            </a>
          )}
          {/* On phones the pill rides in the bottom bar, next to the action it's about. */}
          <span className="hidden sm:contents">
            <KeyPill />
          </span>
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-ink-700 sm:block" />
          <ThemeToggle />
        </div>
      </nav>

      <header className="grid border-b border-ink-700 lg:grid-cols-[420px_minmax(0,1fr)] xl:grid-cols-[480px_minmax(0,1fr)]">
        <div className="min-w-0 px-4 py-8 sm:px-8 lg:py-10">
          <p className="mb-3 text-[13px] leading-5 text-ink-300">Direct-sun check from one street photo</p>
          <h1 className="text-balance text-[clamp(34px,9.6vw,44px)] font-semibold leading-[1.05] tracking-[-0.035em] text-paper sm:text-[48px] lg:text-[44px] xl:text-[48px]">
            How much sun will this apartment get?
          </h1>
          <p className="mt-3 max-w-[440px] text-[14px] leading-[22px] text-ink-300 sm:text-[15px] sm:leading-6">
            Pick a building, click a window, and see how many hours of direct sun it gets on any day of the year. One street photo is all it takes.
          </p>

          <div className="mt-6">
            <ExamplePicker
              examples={examples}
              selectedId={selectedId}
              openingId={loading}
              onSelect={(id) => {
                setPreviewId(null);
                setSelectedId(id);
              }}
              onPreview={setPreviewId}
              onOpen={(id) => {
                setSelectedId(id);
                void openExample(id, 'auto');
              }}
              onBrowse={browse}
              onInteract={interact}
            />
            {idxErr && <p className={clsx('mt-2 text-xs', DANGER_TEXT)}>Could not load examples ({idxErr}).</p>}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Btn kind="primary" className="h-8 w-full px-3 text-[13px] sm:w-auto" disabled={!selected || !!loading} onClick={() => selected && void openExample(selected.id, 'auto')}>
              {opening ? (
                <>
                  <Spinner />
                  Opening {opening.city}…
                </>
              ) : selected ? (
                <>Check an apartment in {selected.city} →</>
              ) : (
                <>Check an apartment →</>
              )}
            </Btn>
            {/* Phones get this action in the fixed bottom bar instead. */}
            <div className="hidden sm:block">
              <Btn kind="solid" className="h-8 px-3 text-[13px]" onClick={browse}>
                Use my own photo
              </Btn>
            </div>
          </div>
          <div aria-live="polite">
            {error && <p className={clsx('mt-2 text-xs', DANGER_TEXT)}>{error}</p>}
            {fileErr && <p className={clsx('mt-2 text-xs', DANGER_TEXT)}>{fileErr}</p>}
          </div>
          <p className="mt-3 text-[11px] leading-4 text-ink-400">Real photos · recorded Roboflow detections · no account needed</p>
        </div>

        {/* The canvas: the example photo sits on it as a frame. */}
        <div className="canvas-dots order-first flex min-w-0 items-center justify-center border-b border-ink-700 px-4 py-6 sm:px-8 sm:py-10 lg:order-none lg:border-b-0 lg:border-l lg:px-10 lg:py-12 xl:px-16">
          <div className="w-full min-w-0 max-w-[760px]">
            <ExampleStage
              example={shown}
              autoplay={!interacted}
              onInteract={interact}
              busy={!!loading}
              onPickWindow={(exampleId, detectionId) => {
                setPreviewId(null);
                setSelectedId(exampleId);
                void openExample(exampleId, 'win-' + detectionId);
              }}
            />
          </div>
        </div>
      </header>

      <div className="max-w-[1120px] px-4 sm:px-8">
        <HowItWorks />

        <section aria-label="Roboflow" className="flex flex-col gap-1 border-t border-ink-700 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-xs leading-[18px] text-ink-300">Window detection by Roboflow RF-DETR. Analysing your own photos uses a shared free allowance.</p>
          <button
            type="button"
            onClick={() => set({ keyDialogOpen: true })}
            aria-haspopup="dialog"
            aria-expanded={keyDialogOpen}
            className="inline-flex min-h-11 shrink-0 items-center self-start rounded-md text-xs font-medium text-accent-300 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:min-h-7 sm:self-auto pointer-coarse:min-h-11"
          >
            Use your own free Roboflow key →
          </button>
        </section>

        <details className="group border-y border-ink-700">
          <summary className="-mx-1 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[13px] font-semibold text-paper focus-visible:outline-2 focus-visible:outline-accent sm:min-h-10 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className="text-ink-400 transition-transform group-open:rotate-90 motion-reduce:transition-none">
              <path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            How sure is this?
          </summary>
          <div className="grid gap-4 pb-4 pl-[18px] pt-1 text-xs leading-[18px] text-ink-300 md:grid-cols-2 md:gap-8">
            <div className="max-w-[460px]">
              <h3 className="mb-1 text-xs font-semibold text-paper">Honest geometry</h3>
              Every number carries provenance — observed, inferred, map, assumed or manual — and a plausible range. Buildings outside the photograph are never presented as reconstructed from it.
            </div>
            <div className="max-w-[460px]">
              <h3 className="mb-1 text-xs font-semibold text-paper">What it is not</h3>
              Estimates are potential direct sunlight under clear skies on a simplified model — not weather, measured indoor brightness, or a professional daylight assessment.
            </div>
          </div>
        </details>
      </div>

      <footer className="mt-12 space-y-1 break-words border-t border-ink-700 px-4 py-5 text-[11px] leading-4 text-ink-400 sm:px-8">
        <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-300">
          <Wordmark size="sm" />
          <span aria-hidden>·</span>
          <span>open source</span>
        </p>
        <p className="max-w-[880px]">Map data © OpenStreetMap contributors (ODbL). Basemap © OpenFreeMap / OpenMapTiles. Photographs from Wikimedia Commons under their respective licenses (see each example). Code: Apache-2.0.</p>
        <p className="max-w-[880px]">
          Facade detection:{' '}
          <a href="https://roboflow.com" target="_blank" rel="noreferrer" className={TEXT_LINK}>
            Roboflow
          </a>{' '}
          (roboflow.com) · Model:{' '}
          <a href="https://universe.roboflow.com/building-facade/building-facade-segmentation-instance" target="_blank" rel="noreferrer" className={TEXT_LINK}>
            building-facade-segmentation-instance v4
          </a>{' '}
          by Building Facade on Roboflow Universe,{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={TEXT_LINK}>
            CC BY 4.0
          </a>
          .
        </p>
      </footer>

      {/* Phones: the own-photo action never scrolls away. Hidden from 640px up, where it sits in the hero. */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-900 px-4 pt-3 sm:hidden"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        role="region"
        aria-label="Your photo"
      >
        <button
          type="button"
          onClick={browse}
          aria-keyshortcuts="U"
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md text-[13px] font-medium text-paper ring-1 ring-inset ring-ink-600 transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CameraIcon className="h-4 w-4 text-ink-300" />
          <span className="btn-label">Use your own photo</span>
        </button>
        <div className="mt-2 flex min-h-7 items-center justify-between gap-2 text-[11px] text-ink-400">
          <span className="truncate">JPG, PNG or WebP · no account</span>
          <KeyPill />
        </div>
      </div>

      {/* RoboflowKeyDialog is mounted by App.tsx for the landing and upload routes. */}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-scrim p-6" role="status" aria-live="assertive">
          <div className="rounded-xl border-2 border-dashed border-accent bg-ink-900 px-10 py-8 text-center shadow-panel">
            <p className="text-[13px] font-semibold text-paper">Drop to analyse your photo</p>
            <p className="mt-1 text-xs text-ink-400">JPG, PNG or WebP</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

const STEPS = [
  {
    title: 'Add a street photo',
    body: 'Use your own photo of the facade, or start from one of the examples.',
  },
  {
    title: 'Detect the windows',
    body: 'Roboflow RF-DETR outlines each window; map footprints turn the facade into 3D.',
  },
  {
    title: 'See the sun hours',
    body: 'Click a window for its hours of direct sun under clear skies, any day of the year.',
  },
] as const;

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="sv-how-title" className="scroll-mt-4 py-8 sm:py-10">
      <h2 id="sv-how-title" className="text-[13px] font-semibold leading-5 text-paper">
        How it works
      </h2>
      <p className="text-xs leading-[18px] text-ink-400">From one street photo to hours of direct sun, in three steps.</p>
      {/* Three columns split by vertical hairlines; stacked rows split by horizontal ones on phones. */}
      <ol className="mt-5 grid list-none divide-y divide-ink-700 p-0 md:grid-cols-3 md:divide-x md:divide-y-0">
        {STEPS.map(({ title, body }, i) => (
          <li key={title} className="flex gap-3 py-3 first:pt-0 last:pb-0 md:px-5 md:py-0 md:first:pl-0 md:last:pr-0">
            <span aria-hidden className="num grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink-800 text-[11px] font-semibold text-ink-300">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold leading-5 text-paper">
                <span className="sr-only">Step {i + 1}: </span>
                {title}
              </h3>
              <p className="mt-0.5 text-xs leading-[18px] text-ink-300">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

type IconProps = { className?: string };

function CameraIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M2.5 5h2l1-1.5h5l1 1.5h2a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75h-11a.75.75 0 0 1-.75-.75v-6.5A.75.75 0 0 1 2.5 5Z" />
      <circle cx="8" cy="8.75" r="2.25" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
