// @vitest-environment jsdom
//
// The remote-wipe watcher (an enrolled Paranoid device) polled its mailbox every
// ~12 s forever — hidden and locked included — about 300 requests an hour from a
// laptop nobody was looking at. Hidden, it now checks every ~2 minutes; becoming
// visible checks at once and goes back to ~12 s.
import { renderHook } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  pollRemoteCommands: vi.fn(async () => ({ etag: null, wiped: false })),
}));

vi.mock('../../sync/remote-unlock', () => ({
  getMailboxPat: vi.fn(async () => 'ghp_token'),
  getRepo: vi.fn(async () => 'owner/repo'),
  pollRemoteCommands: h.pollRemoteCommands,
  refreshRegistryHeartbeat: vi.fn(async () => undefined),
}));
vi.mock('../../db/vault', () => ({ isRemoteUnlockEnrolled: vi.fn(async () => true) }));
vi.mock('../../db/paranoid-flag', () => ({ isParanoidFlagSet: () => true }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));
vi.mock('../../db', () => ({
  db: { localSettings: { get: vi.fn(async () => ({ deviceId: 'dev-1', githubPat: 'ghp_token', githubRepo: 'owner/repo' })) } },
}));

import { useRemoteWipeCommands } from '../../hooks/use-remote-unlock';

let visibility: DocumentVisibilityState;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter lands exactly on the base interval
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  h.pollRemoteCommands.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const polls = () => h.pollRemoteCommands.mock.calls.length;

describe('remote wipe watcher cadence', () => {
  it('polls about every 12 s while visible', async () => {
    renderHook(() => useRemoteWipeCommands());
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls()).toBe(6);
  });

  it('polls every ~2 minutes while hidden', async () => {
    visibility = 'hidden';
    renderHook(() => useRemoteWipeCommands());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(polls()).toBe(3); // at start, then at 2 and 4 minutes
  });

  it('checks at once on becoming visible, then keeps the visible pace', async () => {
    visibility = 'hidden';
    renderHook(() => useRemoteWipeCommands());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls()).toBe(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(polls()).toBe(3);
  });
});
