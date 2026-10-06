import { Component, type ContextType, type ReactNode, type ErrorInfo } from 'react';
import { recordError } from '../lib/diagnostics';
import { ServiceWorkerContext } from '../hooks/use-service-worker';
import { GIT_COMMIT } from '../lib/constants';

interface Props {
  children: ReactNode;
  /** Shown instead of the error screen (null: nothing) — for a part that must not take the app down. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** A transient error being waited out (see isTransient); render a quiet placeholder. */
  retrying: boolean;
}

// A live query stuck behind a long IndexedDB transaction — turning Paranoid Mode
// on or off rewrites every row, which takes a while on a large database and a
// slow device — gives up after Dexie's 60 s waitFor with a TimeoutError. The data
// is fine and the next read succeeds once the transaction commits; replacing the
// app with "Something went wrong" was the wrong answer.
function isTransient(error: Error): boolean {
  return error.name === 'TimeoutError';
}

const MAX_RETRIES = 5;
// A calm spell this long means the next transient error starts a fresh count.
const RETRY_WINDOW_MS = 5 * 60_000;

export class ErrorBoundary extends Component<Props, State> {
  // The update machinery sits above the app's boundary (App.tsx): a build that
  // breaks while rendering can still be replaced — "Reload" alone re-ran it, a
  // waiting worker needs activating.
  static contextType = ServiceWorkerContext;
  declare context: ContextType<typeof ServiceWorkerContext>;
  state: State = { hasError: false, error: null, retrying: false };
  private retries = 0;
  private lastTransientAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
    recordError('react.errorBoundary', error);
    if (!isTransient(error)) return;
    const now = Date.now();
    if (now - this.lastTransientAt > RETRY_WINDOW_MS) this.retries = 0;
    this.lastTransientAt = now;
    if (this.retries >= MAX_RETRIES) return; // it isn't passing: show the error
    this.retries++;
    this.setState({ retrying: true });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ hasError: false, error: null, retrying: false });
    }, 1_000 * this.retries);
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  render() {
    // A given fallback stands in for everything below, the transient wait included.
    if (this.state.hasError && 'fallback' in this.props) return this.props.fallback ?? null;
    // From the very first render after a transient error (componentDidCatch, which
    // counts and schedules the retry, runs after it) until the retries run out.
    const waiting = this.state.hasError && this.state.error !== null && isTransient(this.state.error)
      && (this.state.retrying || this.retries < MAX_RETRIES);
    if (waiting) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-8 dark:bg-neutral-900" role="status">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Still working… one moment.</p>
        </div>
      );
    }
    if (this.state.hasError) {
      const update = this.context?.needRefresh ? this.context : null;
      return (
        <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-8 dark:bg-neutral-900">
          <div className="max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-neutral-800">
            <h1 className="mb-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Something went wrong
            </h1>
            <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => (update ? update.applyUpdate() : window.location.reload())}
              className="rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-700"
            >
              {update ? 'Update and reload' : 'Reload'}
            </button>
            <p className="mt-3 font-mono text-[11px] text-neutral-400">Build {GIT_COMMIT}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
