import { lazy, useState, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * `React.lazy` that can recover from a failed chunk load.
 *
 * React caches a rejected lazy() payload for good, so an ErrorBoundary retry re-throws the same
 * "Failed to fetch dynamically imported module" forever (flaky phone network, or a redeploy that
 * changed chunk hashes while the tab was open). Here a mount after a failure builds a fresh lazy()
 * and so calls `factory` again; once the module has loaded it is rendered directly (no Suspense
 * flash on later mounts).
 */
export function lazyWithRetry<P extends object>(factory: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  let failed = false;
  const load = () =>
    factory().then(
      (m) => {
        loaded = m.default;
        return m;
      },
      (e: unknown) => {
        failed = true;
        throw e;
      },
    );
  let current: LazyExoticComponent<ComponentType<P>> = lazy(load);
  function Retrying(props: P) {
    const [C] = useState<ComponentType<P>>(() => {
      if (loaded) return loaded;
      if (failed) {
        failed = false;
        current = lazy(load);
      }
      return current as unknown as ComponentType<P>;
    });
    return <C {...props} />;
  }
  return Retrying;
}

/** Errors thrown by a dynamic import() whose chunk could not be fetched (Chrome, Safari, Firefox wording). */
export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(msg);
}
