import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from '../lib/lazyWithRetry';
import { Btn } from './ui';

/**
 * Contains render errors so one failing panel (3D view, photo, report) can't unmount the
 * whole app (which would leave a blank page). Shows a small recoverable fallback.
 *
 * Retry re-mounts the children. Lazy panels use lib/lazyWithRetry, so a chunk that failed to load
 * is fetched again; when it still fails (e.g. the app was redeployed while this tab was open) the
 * fallback also offers a page reload, which keeps the current #/example link.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode; label?: string; fullPage?: boolean; resetKey?: unknown; back?: { label: string; onClick: () => void } },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[sunvisionai] ${this.props.label ?? 'view'} crashed:`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = () => this.setState({ error: null });
    const chunk = isChunkLoadError(error);
    const message = chunk ? 'Part of the app could not be downloaded. Check the connection and try again.' : error.message;
    const reload = chunk ? (
      <Btn kind="solid" onClick={() => location.reload()}>
        Reload the page
      </Btn>
    ) : null;
    if (this.props.fullPage)
      return (
        <div role="alert" className="grid h-full place-items-center bg-ink-950 p-6 text-paper">
          <div className="w-full max-w-sm">
            <p className="text-[13px] font-semibold leading-5">Something went wrong.</p>
            <p className="mt-1 text-xs leading-[18px] text-ink-300">{message}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn kind="primary" onClick={retry}>
                Try again
              </Btn>
              {reload}
              <Btn kind="solid" onClick={() => (location.href = location.pathname)}>
                Start over
              </Btn>
            </div>
          </div>
        </div>
      );
    return (
      <div role="alert" className="grid h-full min-h-[160px] place-items-center p-4">
        <div className="w-full max-w-xs">
          <p className="text-xs font-medium leading-4 text-paper">The {this.props.label ?? 'view'} hit an error.</p>
          <p className="mt-1 text-[11px] leading-4 text-ink-400">{message}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Btn kind="solid" onClick={retry}>
              Reload this view
            </Btn>
            {chunk && (
              <Btn kind="ghost" onClick={() => location.reload()}>
                Reload the page
              </Btn>
            )}
            {this.props.back && (
              <Btn kind="ghost" onClick={this.props.back.onClick}>
                {this.props.back.label}
              </Btn>
            )}
          </div>
        </div>
      </div>
    );
  }
}
