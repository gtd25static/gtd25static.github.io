import { vi, type Mock } from 'vitest';
import { resetDb } from '../helpers/db-helpers';
import { setupSyncCredentials } from '../helpers/sync-helpers';

// Reliability review 2026-10-05, scheduler. The idle poll re-armed itself
// whenever the state read 'idle': a network flap while a poll was in flight
// started a second chain that nothing could stop any more, a poll in flight when
// the tab hid kept polling in the background, and a rate-limit "pause" was
// re-armed by the very poll that hit the limit.

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  // The idle probe's conditional GET: failing, every poll falls through to a full sync.
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn(), getFileConditional: vi.fn(() => Promise.reject(new Error('no network in tests'))) };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => ({
  ...(await vi.importActual('../../sync/remote-backups')),
  maybeCreateBackups: vi.fn(() => Promise.resolve()),
}));

import { getFile, putFile, getFileConditional, RateLimitError } from '../../sync/github-api';
import { startScheduler, stopScheduler, __resetForTesting, CHANGELOG_FILE } from '../../sync/sync-engine';
import { toast } from '../../components/ui/Toast';
import { recordServerDate, __resetClockSkewForTests } from '../../lib/clock-skew';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** How many syncs started (each reads the changelog once). */
function syncsStarted(): number {
  return mockGetFile.mock.calls.filter((c) => c[2] === CHANGELOG_FILE).length;
}

beforeEach(async () => {
  vi.clearAllMocks();
  stopScheduler();
  __resetForTesting();
  await resetDb();
  await setupSyncCredentials();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  mockGetFile.mockResolvedValue(null);
  mockPutFile.mockResolvedValue('sha');
  vi.useFakeTimers();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  __resetClockSkewForTests();
});

async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(50);
}

describe('one idle poll chain, and none while hidden', () => {
  it('a network flap during an in-flight poll does not start a second chain', async () => {
    startScheduler();
    await settle();
    // The next poll hangs on the network…
    let release!: () => void;
    mockGetFile.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    await vi.advanceTimersByTimeAsync(30_000);
    // …while the connection flaps.
    window.dispatchEvent(new Event('online'));
    await settle();
    release();
    await settle();

    const before = syncsStarted();
    await vi.advanceTimersByTimeAsync(90_000);
    // One chain: three polls in 90 s. Two chains made six.
    expect(syncsStarted() - before).toBeLessThanOrEqual(3);
  });

  it('a poll in flight when the tab hides does not re-arm', async () => {
    startScheduler();
    await settle();
    let release!: () => void;
    mockGetFile.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility('hidden');
    release();
    await settle();

    const before = syncsStarted();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(syncsStarted()).toBe(before);
  });
});

describe('a rate limit pauses everything until it resets', () => {
  it('no request goes out before the reset, and syncing resumes after it', async () => {
    startScheduler();
    await settle();
    const resetAt = Date.now() + 10 * 60_000;
    mockGetFile.mockRejectedValueOnce(new RateLimitError(resetAt));
    await vi.advanceTimersByTimeAsync(30_000); // the poll that hits the limit
    await settle();
    const atLimit = mockGetFile.mock.calls.length;

    // Polls, an online event and a visibility return all wait.
    window.dispatchEvent(new Event('online'));
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(mockGetFile.mock.calls.length).toBe(atLimit);
    expect((toast as Mock).mock.calls.filter((c) => /Rate limited/.test(String(c[0]))).length).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(mockGetFile.mock.calls.length).toBeGreaterThan(atLimit);
  });
});

describe('a rate limit with this device\'s clock ahead (reliability review 2026-10-06, B4)', () => {
  it('pauses as long as the limit says, not hours more', async () => {
    recordServerDate(new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString()); // 2 h ahead
    startScheduler();
    await settle();
    mockGetFile.mockRejectedValueOnce(new RateLimitError(Date.now() + 10 * 60_000));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const atLimit = mockGetFile.mock.calls.length;

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(mockGetFile.mock.calls.length).toBeGreaterThan(atLimit);
  });
});

// Reliability review 2026-10-06 (M15): only a Paranoid device asked "changed?"
// first; every other one downloaded the whole snapshot on every 30-second poll.
describe('the idle poll of a device without Paranoid Mode', () => {
  // What the probe decides is tested in idle-probe*.test.ts; here, that it is asked.
  it('asks "changed?" first, like a Paranoid one', async () => {
    startScheduler();
    await settle();
    vi.mocked(getFileConditional).mockClear();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(getFileConditional)).toHaveBeenCalled();
  });
});

describe('repeated failures do not toast every time', () => {
  it('a failing sync toasts once per streak, not on every poll', async () => {
    mockGetFile.mockRejectedValue(new Error('GitHub API error: 401'));
    startScheduler();
    await settle();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const failures = (toast as Mock).mock.calls.filter((c) => c[0] === 'Sync failed').length;
    expect(failures).toBe(1);
  });
});
