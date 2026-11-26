/**
 * Landing example picker: one radio card per curated example, then a separate
 * "Your photo" card. Hover 150 ms previews on the stage (mouse only), click selects,
 * double-click or Enter opens. Arrow keys cycle (roving tab index). The page-level number-key
 * (1–9, one per example) / U shortcuts live in Landing.tsx because they work wherever focus is (except in text inputs).
 *
 * Layout: small cards with the photo on top, the name and
 * place under it, a 2 px accent ring on the selected one. Below 1024px the cards are a
 * horizontal scroll-snap row; the photo tile sits on its own full-width row under it, so it
 * never scrolls out of reach with the examples. From 1024px they form a two-column grid, short
 * enough that four examples keep the hero's call to action above the fold.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { prefetchImage, type ExampleIndexEntry } from '../../lib/examples';
import { useCoarsePointer } from './ExampleStage';

export interface ExamplePickerProps {
  /** null while examples/index.json is loading. */
  examples: ExampleIndexEntry[] | null;
  selectedId: string | null;
  /** The example being opened (store.loading), if any. */
  openingId?: string | null;
  onSelect: (id: string) => void;
  /** Hover preview after 150 ms; null when the pointer leaves the picker. */
  onPreview: (id: string | null) => void;
  onOpen: (id: string) => void;
  /** Open the file picker. Dropped files are handled page-wide by Landing. */
  onBrowse: () => void;
  /** First pointer or keyboard interaction (stops the stage autoplay). */
  onInteract: () => void;
}

const HOVER_MS = 150;

/** Placeholder cards while examples/index.json loads (as many as the curated examples we ship). */
const SKELETON: null[] = [null, null, null, null];

/** Card width: a partial third card shows on a 360px phone (hints at the scroll); the grid sets it from 1024px. */
const CARD_W = 'w-[168px] sm:w-[184px] lg:w-auto';

/** Thumbnail shape, shared by the cards and their loading placeholders so nothing shifts. */
const THUMB = 'aspect-[2/1] w-full';

export default function ExamplePicker({ examples, selectedId, openingId, onSelect, onPreview, onOpen, onBrowse, onInteract }: ExamplePickerProps) {
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [dropHot, setDropHot] = useState(false);
  const coarse = useCoarsePointer();

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  const move = (from: number, delta: number) => {
    if (!examples?.length) return;
    const next = examples[(from + delta + examples.length) % examples.length];
    onInteract();
    onSelect(next.id);
    const el = cardRefs.current[next.id];
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, i: number, id: string) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        move(i, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        move(i, -1);
        break;
      case 'Enter':
        e.preventDefault();
        onInteract();
        onOpen(id);
        break;
      case ' ':
        e.preventDefault();
        onInteract();
        onSelect(id);
        break;
    }
  };

  /** The stage shows the full photo; start loading it as soon as a card is pointed at or focused. */
  const warmStage = (id: string) => {
    const ex = examples?.find((x) => x.id === id);
    if (ex) prefetchImage(`examples/${ex.id}/${ex.thumbnail ?? 'photo.jpg'}`);
  };

  /** Hover preview is a mouse affordance: a finger swiping the row must not swap the stage. */
  const onCardEnter = (e: PointerEvent<HTMLDivElement>, id: string) => {
    clearHover();
    warmStage(id);
    if (e.pointerType !== 'mouse') return;
    hoverTimer.current = setTimeout(() => {
      onInteract();
      onPreview(id);
    }, HOVER_MS);
  };

  const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const tabStop = selectedId && examples?.some((x) => x.id === selectedId) ? selectedId : examples?.[0]?.id;

  return (
    <div className="min-w-0">
      <p id="sv-picker-label" className="mb-1 flex h-6 items-center text-[11px] font-semibold text-paper">
        Try an example
      </p>
      <div
        role="radiogroup"
        aria-labelledby="sv-picker-label"
        // pt/pb leave room for the selection ring and focus outline inside the scroller (it clips both axes).
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-2 pt-1 sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0 lg:pb-0 lg:pt-0"
        onPointerLeave={(e) => {
          clearHover();
          if (e.pointerType === 'mouse') onPreview(null);
        }}
      >
        {(examples ?? SKELETON).map((ex, i) =>
          ex ? (
            <div
              // Keyed by slot so the skeleton's DOM node (a snap target) is reused and scroll-snap stays on the first card.
              key={`slot-${i}`}
              ref={(el) => {
                cardRefs.current[ex.id] = el;
              }}
              role="radio"
              aria-checked={ex.id === selectedId}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              aria-describedby="sv-picker-help"
              tabIndex={ex.id === tabStop ? 0 : -1}
              onKeyDown={(e) => onCardKey(e, i, ex.id)}
              onPointerEnter={(e) => onCardEnter(e, ex.id)}
              onFocus={() => warmStage(ex.id)}
              onPointerLeave={clearHover}
              onClick={() => {
                onInteract();
                onSelect(ex.id);
              }}
              onDoubleClick={() => {
                onInteract();
                onOpen(ex.id);
              }}
              className={clsx(
                'group relative flex shrink-0 snap-start cursor-pointer flex-col overflow-hidden rounded-lg bg-ink-900 text-left transition-shadow outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                CARD_W,
                // Selection: a 2 px blue ring; unselected cards keep a hairline.
                ex.id === selectedId ? 'ring-2 ring-accent' : 'ring-1 ring-ink-700 hover:ring-ink-500',
              )}
            >
              <img
                src={`examples/${ex.id}/${ex.card ?? ex.thumbnail ?? 'photo.jpg'}`}
                alt=""
                loading="lazy"
                draggable={false}
                className={clsx(THUMB, 'shrink-0 border-b border-ink-700 bg-ink-800 object-cover')}
              />
              <span className="flex h-11 min-w-0 items-center gap-2 px-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-medium leading-4 text-paper">{ex.title}</span>
                  <span className="truncate text-[11px] leading-4 text-ink-400">{ex.city}</span>
                </span>
                <kbd aria-hidden className="num hidden h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-ink-800 px-1 font-sans text-[10px] font-medium leading-4 text-ink-400 lg:grid">
                  {i + 1}
                </kbd>
              </span>
              {openingId === ex.id && (
                <span className="absolute inset-0 z-[2] grid place-items-center bg-ink-900/80 text-[11px] font-medium text-paper" aria-hidden>
                  Opening…
                </span>
              )}
            </div>
          ) : (
            <div key={`slot-${i}`} aria-hidden className={clsx('flex shrink-0 snap-start flex-col overflow-hidden rounded-lg ring-1 ring-ink-700', CARD_W)}>
              <div className={clsx(THUMB, 'animate-pulse border-b border-ink-700 bg-ink-800 motion-reduce:animate-none')} />
              <div className="flex h-11 flex-col justify-center gap-1.5 px-2.5">
                <div className="h-2 w-3/4 rounded-sm bg-ink-800" />
                <div className="h-2 w-1/2 rounded-sm bg-ink-800" />
              </div>
            </div>
          ),
        )}
      </div>

      {/* Photo card: browse on click, accepts drops. Not a radio (it starts the upload flow), so it sits outside the group. */}
      <button
        type="button"
        onClick={onBrowse}
        aria-keyshortcuts="U"
        onDragOver={(e) => {
          if (!hasFile(e)) return;
          e.preventDefault();
          setDropHot(true);
        }}
        onDragLeave={() => setDropHot(false)}
        // The drop itself is handled page-wide by Landing (any drop on the landing goes to the upload flow).
        onDrop={() => setDropHot(false)}
        className={clsx(
          'mt-2 flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          dropHot ? 'border-accent bg-selected' : 'border-ink-500 hover:border-ink-400 hover:bg-ink-800',
        )}
      >
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ink-800 text-ink-200">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
          </svg>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-medium leading-4 text-paper">Your photo</span>
          <span className="truncate text-[11px] leading-4 text-ink-400">{coarse ? 'Take a photo or choose one' : 'Drop it here or browse'}</span>
        </span>
        <kbd aria-hidden className="num hidden h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-ink-800 px-1 font-sans text-[10px] font-medium leading-4 text-ink-400 lg:grid">
          U
        </kbd>
      </button>

      <p id="sv-picker-help" className="sr-only">
        Arrow keys change the example, Enter opens it. Keys 1 to {examples?.length ?? SKELETON.length} select an example; U opens your own photo.
      </p>
    </div>
  );
}
