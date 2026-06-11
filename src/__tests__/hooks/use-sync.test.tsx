// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { SyncProgress } from '../../sync/sync-engine';

// Capture the progress callback the hook registers; neuter the scheduler.
const h = vi.hoisted(() => ({ progressCb: null as ((p: SyncProgress) => void) | null }));
vi.mock('../../sync/sync-engine', () => ({
  setSyncProgressCallback: (cb: ((p: SyncProgress) => void) | null) => { h.progressCb = cb; },
  startScheduler: vi.fn(),
  stopScheduler: vi.fn(),
  syncNow: vi.fn(),
}));

import { SyncProvider, useSyncContext } from '../../sync/use-sync';

function Probe() {
  const { lastErrorInfo, online } = useSyncContext();
  return (
    <div data-testid="probe">
      {online ? 'online' : 'offline'}|{lastErrorInfo ? `${lastErrorInfo.category}:${lastErrorInfo.message}` : 'no-error'}
    </div>
  );
}

function renderProbe() {
  return render(
    <SyncProvider>
      <Probe />
    </SyncProvider>,
  );
}

const errorProgress: SyncProgress = {
  phase: 'error',
  label: 'GitHub API error: 401',
  progress: 0,
  errorInfo: { category: 'auth', message: 'GitHub API error: 401' },
};

beforeEach(() => {
  h.progressCb = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useSync error persistence', () => {
  it('keeps lastErrorInfo until the next successful sync (no 4s auto-clear)', () => {
    vi.useFakeTimers();
    renderProbe();
    act(() => h.progressCb!(errorProgress));
    expect(screen.getByTestId('probe')).toHaveTextContent('auth:GitHub API error: 401');

    // The old behavior cleared the error after 4s — it must persist now
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId('probe')).toHaveTextContent('auth:GitHub API error: 401');

    act(() => h.progressCb!({ phase: 'done', label: 'Sync complete', progress: 1, pulled: 0, pushed: 0 }));
    expect(screen.getByTestId('probe')).toHaveTextContent('no-error');
  });

  it('falls back to an unknown category when the engine sends no errorInfo', () => {
    renderProbe();
    act(() => h.progressCb!({ phase: 'error', label: 'Force push refused', progress: 0 }));
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown:Force push refused');
  });
});

describe('useSync connectivity tracking', () => {
  it('tracks window online/offline events', () => {
    renderProbe();
    expect(screen.getByTestId('probe')).toHaveTextContent('online');

    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByTestId('probe')).toHaveTextContent('offline');

    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByTestId('probe')).toHaveTextContent('online');
  });
});
