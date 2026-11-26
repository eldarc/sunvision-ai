/**
 * LayersPopover (Advanced only): every photo layer toggle and the detection class chips, in one
 * popover opened from the photo toolbar.
 */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Detection } from '../../schema/scene';
import { useStore } from '../../state/store';
import { Toggle } from '../ui';

const LAYER_LABELS = [
  ['masks', 'Masks'],
  ['boxes', 'Boxes'],
  ['labels', 'Labels'],
  ['depth', 'Depth'],
  ['floors', 'Floors'],
  ['dims', 'Dimensions'],
  ['alignment', 'Alignment'],
] as const;

export function countByClass(ds: Detection[]) {
  const o: Record<string, number> = {};
  for (const d of ds) o[d.cls] = (o[d.cls] ?? 0) + 1;
  return Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] === 'window' ? -1 : b[0] === 'window' ? 1 : b[1] - a[1])));
}

/** Whether a detection class is currently shown (street is hidden unless explicitly enabled). */
export const classVisible = (classes: Record<string, boolean>, cls: string) => classes[cls] !== false && (cls !== 'street' || classes['street'] === true);

export default function LayersPopover({ detections, colors, primary }: { detections: Detection[]; colors: Record<string, number>; primary: boolean }) {
  const layers = useStore((s) => s.layers);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const counts = countByClass(detections.filter((d) => !d.deleted));
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'inline-flex h-7 items-center gap-1 rounded-md pl-2 pr-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11',
          open ? 'bg-ink-800 text-paper' : 'text-ink-200 hover:bg-ink-800 hover:text-paper',
        )}
      >
        Layers
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={clsx('text-ink-400 transition-transform motion-reduce:transition-none', open && 'rotate-180')}>
          <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="dialog" aria-label="Photo layers" className="pop-in absolute right-0 top-full z-30 mt-1 max-h-[70vh] w-[min(15rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg bg-ink-900 py-1 text-xs shadow-panel pointer-coarse:[&_label]:min-h-11">
          <div className="grid grid-cols-2 gap-x-3 px-3">
            {LAYER_LABELS.map(([k, l]) => (
              <Toggle key={k} checked={layers[k]} onChange={(v) => set({ layers: { ...layers, [k]: v } })} label={l} />
            ))}
          </div>
          {!primary && <p className="px-3 pb-2 pt-1 text-[11px] leading-4 text-ink-400">Floors and dimensions are measured on the main photo only.</p>}
          {Object.keys(counts).length > 0 && (
            <div className="mt-1 border-t border-ink-700 px-3 pb-2">
              <div className="flex h-8 items-center text-[11px] font-semibold text-paper">Classes</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(counts).map(([cls, n]) => {
                  const on = classVisible(layers.classes, cls);
                  return (
                    <button
                      key={cls}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ layers: { ...layers, classes: { ...layers.classes, [cls]: !on } } })}
                      className={clsx(
                        'flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[11px] ring-1 ring-inset ring-ink-700 transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-11 pointer-coarse:px-2.5',
                        !on && 'opacity-50 line-through decoration-ink-400',
                      )}
                      title={on ? `Hide ${cls}` : `Show ${cls}`}
                    >
                      <span aria-hidden className="h-2 w-2 rounded-xs" style={{ background: hex(colors[cls] ?? 0xc9ccd1) }} />
                      <span className="text-ink-200">{cls}</span>
                      <span className="num text-ink-400">{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
