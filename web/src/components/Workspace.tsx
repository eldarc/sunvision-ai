/**
 * Workspace shell. Simple mode: photo | 3D | SunReport, with the DayBar under
 * photo and 3D; below 1024px everything stacks with the answer first. Advanced mode: photo/map,
 * 3D, the Inspector and the full Timeline.
 *
 * Panels are docked edge to edge and divided by 1px hairlines (no gutters, corners or shadows); the
 * 3D view is the canvas (ink-950), the panels around it are ink-900.
 *
 * Phones (and tablets below 1024px) scroll one column (answer, photo, 3D, the rest of the report)
 * with the day bar docked at the bottom for the thumb; below 640px it is the compact `dock` variant.
 * Every panel sits in its own ErrorBoundary, so one failing view never blanks the page.
 */
import ErrorBoundary from './ErrorBoundary';
import { Suspense, useSyncExternalStore } from 'react';
import { lazyWithRetry } from '../lib/lazyWithRetry';
import { useStore } from '../state/store';
import { SimProvider } from './SimContext';
import PhotoPanel from './PhotoPanel';
import Inspector from './Inspector';
import Timeline, { DayBar } from './Timeline';
import TopBar from './TopBar';
import SunReport from './SunReport';
import RoboflowKeyDialog from './roboflow/RoboflowKeyDialog';
import RoomControls from './twin/RoomControls';
import { Segmented } from './ui';

// lazyWithRetry: "Reload this view" fetches a chunk again after a failed load (React caches lazy() rejections).
const TwinView = lazyWithRetry(() => import('./TwinView'));
const MapPanel = lazyWithRetry(() => import('./MapPanel'));

/** Docked panels: flat, edge to edge, divided by 1px hairlines (set per layout), no corners or shadow. */
const panel = 'overflow-hidden bg-ink-900';
const hair = 'border-ink-700';

function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => {};
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : true),
    () => true,
  );
}

/* pendingSelection (landing → sample apartment) is resolved by SimProvider (lib/useSim usePendingSelection). */

function Loading({ what }: { what: string }) {
  return <div className="grid h-full place-items-center text-[11px] text-ink-400">{what}</div>;
}

function TwinSection({ className, id }: { className?: string; id?: string }) {
  return (
    <section id={id} className={`relative overflow-hidden bg-ink-950 ${className ?? ''}`} aria-label="3D digital twin">
      <Suspense fallback={<Loading what="Loading 3D view…" />}>
        <ErrorBoundary label="3D view"><TwinView /></ErrorBoundary>
      </Suspense>
    </section>
  );
}

/** Advanced: photo/map tabs. Simple: the photo only (the Map tab lives in Advanced). */
function LeftPanel({ advanced, id }: { advanced: boolean; id?: string }) {
  const tab = useStore((s) => s.leftTab);
  const set = useStore((s) => s.set);
  const showMap = advanced && tab === 'map';
  return (
    <section id={id} className={`flex min-h-0 flex-1 flex-col ${panel}`} aria-label={advanced ? 'Photograph and map' : 'Photograph'}>
      {advanced && (
        <div className={`flex h-10 shrink-0 items-center overflow-x-auto border-b px-3 ${hair}`}>
          <Segmented
            size="xs"
            value={tab}
            onChange={(v) => set({ leftTab: v })}
            options={[
              { value: 'photo', label: 'Photograph · Roboflow detections' },
              { value: 'map', label: 'Map' },
            ]}
          />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {showMap ? (
          <Suspense fallback={<Loading what="Loading map…" />}>
            <ErrorBoundary label="map"><MapPanel /></ErrorBoundary>
          </Suspense>
        ) : (
          <ErrorBoundary label="photo panel"><PhotoPanel /></ErrorBoundary>
        )}
      </div>
    </section>
  );
}

function AdvancedLayout() {
  return (
    <main className="relative grid min-h-0 flex-1 grid-cols-1 content-start overflow-y-auto overflow-x-hidden bg-ink-950 lg:grid-cols-[minmax(320px,36fr)_minmax(360px,44fr)_340px] lg:grid-rows-[minmax(0,1fr)_auto] lg:content-normal">
      <div className={`flex h-[min(62vh,440px)] min-h-[300px] flex-col border-b lg:h-auto lg:min-h-0 lg:border-b-0 lg:border-r ${hair}`}>
        <LeftPanel advanced />
      </div>
      <TwinSection className={`h-[min(62vh,420px)] min-h-[320px] border-b lg:h-auto lg:min-h-0 lg:border-b-0 ${hair}`} />
      <aside data-inspector className={`min-h-[420px] min-w-0 border-b lg:row-span-2 lg:min-h-0 lg:border-b-0 lg:border-l ${hair} ${panel}`} aria-label="Property inspector">
        <ErrorBoundary label="inspector"><Inspector /></ErrorBoundary>
      </aside>
      <section className={`min-w-0 lg:col-span-2 lg:border-t ${hair} ${panel}`} aria-label="Sunlight timeline">
        <ErrorBoundary label="timeline"><Timeline /></ErrorBoundary>
      </section>
    </main>
  );
}

function SimpleWide() {
  return (
    <main className="relative grid min-h-0 flex-1 grid-cols-[minmax(300px,1fr)_minmax(340px,1.3fr)_300px] grid-rows-[minmax(0,1fr)_auto] bg-ink-950 xl:grid-cols-[minmax(360px,1fr)_minmax(420px,1.3fr)_320px]">
      <div className={`flex min-h-0 flex-col border-r ${hair}`}>
        <LeftPanel advanced={false} />
      </div>
      <TwinSection className="min-h-0" />
      <aside className={`row-span-2 min-h-0 border-l ${hair} ${panel}`} aria-label="Your sunlight report">
        <ErrorBoundary label="sunlight report"><SunReport part="all" /></ErrorBoundary>
      </aside>
      <section className={`col-span-2 border-t ${hair} ${panel}`} aria-label="Day timeline">
        <ErrorBoundary label="day bar"><DayBar /></ErrorBoundary>
      </section>
    </main>
  );
}

/**
 * Below 1024px: answer, photo, 3D, then the rest of the report, in one scrolling column; the day
 * bar is docked under it (thumb reach, always visible while scrubbing). Section ids are the jump
 * targets of the answer card's collapsed header (SunReport).
 */
function SimpleNarrow({ phone }: { phone: boolean }) {
  return (
    <>
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain bg-ink-900">
        <ErrorBoundary label="sunlight report"><SunReport part="answer" roomControls={<RoomControls variant="card" />} /></ErrorBoundary>
        <div className={`flex h-[min(62vh,440px)] min-h-[280px] shrink-0 scroll-mt-14 flex-col border-y ${hair}`} id="sv-photo">
          <LeftPanel advanced={false} />
        </div>
        <TwinSection id="sv-twin" className={`h-[min(56vh,420px)] min-h-[300px] shrink-0 scroll-mt-14 border-b ${hair}`} />
        <div id="sv-more" className="scroll-mt-14">
          <ErrorBoundary label="sunlight report"><SunReport part="rest" /></ErrorBoundary>
        </div>
      </main>
      <section className={`relative z-20 shrink-0 border-t bg-ink-900 ${hair}`} aria-label="Day timeline">
        <ErrorBoundary label="day bar"><DayBar variant={phone ? 'dock' : 'bar'} /></ErrorBoundary>
      </section>
    </>
  );
}

export default function Workspace() {
  const uiMode = useStore((s) => s.uiMode);
  const wide = useMedia('(min-width: 1024px)');
  const phone = !useMedia('(min-width: 640px)');
  const advanced = uiMode === 'advanced';
  return (
    <SimProvider>
      <div className="relative flex h-full flex-col overflow-hidden bg-ink-950 supports-[height:100dvh]:h-dvh">
        <ErrorBoundary label="top bar"><TopBar /></ErrorBoundary>
        {advanced ? <AdvancedLayout /> : wide ? <SimpleWide /> : <SimpleNarrow phone={phone} />}
      </div>
      <RoboflowKeyDialog />
    </SimProvider>
  );
}
