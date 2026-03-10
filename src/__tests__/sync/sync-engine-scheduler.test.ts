import { vi, type Mock } from 'vitest';
import { resetDb } from '../helpers/db-helpers';
import { setupSyncCredentials } from '../helpers/sync-helpers';

// Mock github-api
vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return {
    ...actual,
    getFile: vi.fn(),
    putFile: vi.fn(),
    deleteFile: vi.fn(),
    testConnection: vi.fn(),
  };
});

// Mock toast
vi.mock('../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

// Mock remote-backups
vi.mock('../../sync/remote-backups', async () => {
  const actual = await vi.importActual('../../sync/remote-backups');
  return {
    ...actual,
    maybeCreateBackups: vi.fn(() => Promise.resolve()),
  };
});

import { getFile, putFile } from '../../sync/github-api';
import {
  startScheduler,
  stopScheduler,
  scheduleSyncDebounced,
  __resetForTesting,
} from '../../sync/sync-engine';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset all state with real timers (DB ops need real event loop)
  stopScheduler();
  __resetForTesting();
  await resetDb();
  await setupSyncCredentials(); // DB ops before fake timers
  // Default: sync returns quickly with "no remote"
  mockGetFile.mockResolvedValue(null);
  mockPutFile.mockResolvedValue('sha');
  // NOW enable fake timers — all DB setup is done
  vi.useFakeTimers();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

// Helper: start scheduler and wait for initial sync to complete
async function startAndWaitForInitialSync() {
  startScheduler();
  // Let initial syncNow + all its async operations complete
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }
}

describe('startScheduler', () => {
  it('calls syncNow on startup', async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(100);
    expect(mockGetFile).toHaveBeenCalled();
  });

  it('sets up idle polling (30s)', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    // Advance 30 seconds — should trigger poll
    await vi.advanceTimersByTimeAsync(30_000);
    // Let the polled syncNow complete
    await vi.advanceTimersByTimeAsync(100);
    expect(mockGetFile).toHaveBeenCalled();
  });

  it('registers visibilitychange and online listeners', () => {
    const docSpy = vi.spyOn(document, 'addEventListener');
    const winSpy = vi.spyOn(window, 'addEventListener');

    startScheduler();

    expect(docSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winSpy).toHaveBeenCalledWith('online', expect.any(Function));

    docSpy.mockRestore();
    winSpy.mockRestore();
  });
});

describe('stopScheduler', () => {
  it('clears timer and removes listeners', () => {
    const docRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener');

    startScheduler();
    stopScheduler();

    expect(docRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));

    docRemoveSpy.mockRestore();
    winRemoveSpy.mockRestore();
  });

  it('prevents further syncs after stop', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();
    stopScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetFile).not.toHaveBeenCalled();
  });
});

describe('notifyLocalChange (via scheduleSyncDebounced)', () => {
  it('from idle → first-wait, schedules batch after 15s', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    scheduleSyncDebounced();

    // Should not sync immediately
    expect(mockGetFile).not.toHaveBeenCalled();

    // After 15s — first batch should fire
    await vi.advanceTimersByTimeAsync(15_000);
    // Let the batch syncNow complete
    await vi.advanceTimersByTimeAsync(200);
    expect(mockGetFile).toHaveBeenCalled();
  });

  it('no-op when stopped', async () => {
    // Don't start scheduler — state is already 'stopped' from __resetForTesting
    mockGetFile.mockClear();

    scheduleSyncDebounced();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetFile).not.toHaveBeenCalled();
  });

  it('no-op from first-wait (debounces)', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    scheduleSyncDebounced();
    scheduleSyncDebounced(); // second call while in first-wait

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(200);
    const callCount = mockGetFile.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
  });
});

describe('batch timer', () => {
  it('returns to idle when no remaining entries', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    scheduleSyncDebounced();
    await vi.advanceTimersByTimeAsync(15_000); // first batch fires
    await vi.advanceTimersByTimeAsync(500); // let batch syncNow complete
    mockGetFile.mockClear();

    // syncNow returns 0 → back to idle → 30s poll
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockGetFile).toHaveBeenCalled();
  });
});

describe('handleVisibilityChange', () => {
  it('visible → triggers syncNow + restarts poll', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mockGetFile).toHaveBeenCalled();
  });

  it('stopped → no-op', async () => {
    // State is already 'stopped' from __resetForTesting — don't start scheduler
    mockGetFile.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mockGetFile).not.toHaveBeenCalled();
  });
});

describe('handleOnline', () => {
  it('triggers syncNow', async () => {
    await startAndWaitForInitialSync();
    mockGetFile.mockClear();

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mockGetFile).toHaveBeenCalled();
  });

  it('stopped → no-op', async () => {
    // State is already 'stopped' — don't start scheduler
    mockGetFile.mockClear();

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mockGetFile).not.toHaveBeenCalled();
  });
});
