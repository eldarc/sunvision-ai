import { Suspense, useEffect, useState } from 'react';
import { useStore } from './state/store';
import Landing from './components/Landing';
import ErrorBoundary from './components/ErrorBoundary';
import RoboflowKeyDialog from './components/roboflow/RoboflowKeyDialog';
import { loadExample } from './lib/examples';
import { useApplyTheme } from './lib/theme';
import { lazyWithRetry } from './lib/lazyWithRetry';

// lazyWithRetry: "Try again" re-fetches a chunk that failed to load (React caches lazy() rejections).
const Workspace = lazyWithRetry(() => import('./components/Workspace'));
const QuickUpload = lazyWithRetry(() => import('./components/upload/QuickUpload'));
/** The step-by-step wizard behind "Place the camera manually ▸" (#/upload/manual). */
const UploadWizard = lazyWithRetry(() => import('./components/UploadWizard'));

export default function App() {
  // Mirrors the resolved theme (system / light / dark) onto <html data-theme> once, for the whole app.
  useApplyTheme();
  const route = useStore((s) => s.route);
  const scene = useStore((s) => s.scene);
  const [uploadVariant, setUploadVariant] = useState<'quick' | 'manual'>(() => (typeof location !== 'undefined' && location.hash === '#/upload/manual' ? 'manual' : 'quick'));

  useEffect(() => {
    // Deep links: on first load and whenever the hash changes inside the running app.
    const route = () => {
      const m = location.hash.match(/^#\/example\/([\w-]+)/);
      if (m) {
        if (useStore.getState().scene?.id !== m[1]) loadExample(m[1]);
      } else if (/^#\/upload/.test(location.hash)) {
        setUploadVariant(/^#\/upload\/manual\b/.test(location.hash) ? 'manual' : 'quick');
        useStore.getState().set({ route: { name: 'upload' } });
      }
    };
    route();
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
  }, []);
  useEffect(() => {
    // Read the live route: on first load the deep-link handler above has already switched it in this
    // same commit, and this render's `route` would still say 'landing' (stripping the hash).
    const live = useStore.getState().route.name;
    if (live === 'landing' && location.hash) history.replaceState(null, '', location.pathname);
    if (live !== 'upload') setUploadVariant('quick');
  }, [route.name]);

  const inWorkspace = route.name === 'workspace' && !!scene;
  return (
    <ErrorBoundary fullPage label="app" resetKey={route.name}>
    <Suspense fallback={<div className="grid h-full place-items-center bg-ink-950 text-[11px] text-ink-400">Loading…</div>}>
      {inWorkspace ? (
        <Workspace />
      ) : route.name === 'upload' ? (
        // Its own boundary: an upload-step error offers a way back instead of replacing the page.
        <ErrorBoundary label="upload step" resetKey={uploadVariant} back={{ label: 'Back to the start', onClick: () => useStore.getState().set({ route: { name: 'landing' } }) }}>
          {uploadVariant === 'manual' ? <UploadWizard /> : <QuickUpload onPlaceManually={() => setUploadVariant('manual')} />}
        </ErrorBoundary>
      ) : (
        <Landing />
      )}
      {/* The workspace mounts its own key dialog; landing and upload use this one. */}
      {!inWorkspace && <RoboflowKeyDialog />}
    </Suspense>
    </ErrorBoundary>
  );
}
