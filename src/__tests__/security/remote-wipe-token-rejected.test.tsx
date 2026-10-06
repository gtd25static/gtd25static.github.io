// @vitest-environment jsdom
//
// Reliability review 2026-10-06 (B11): the remote-wipe watcher swallowed every
// error. With an expired token every poll failed with 401 and the device was
// silently out of reach of a remote wipe, while Settings still said "Enabled".
// The rejection is now noted (for the owner to see once unlocked — never on the
// lock screen) and cleared by the next poll that works.
import { renderHook } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  pollRemoteCommands: vi.fn(),
  local: { deviceId: 'dev-1', githubRepo: 'owner/repo' } as Record<string, unknown>,
  update: vi.fn(),
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
  db: {
    localSettings: {
      get: vi.fn(async () => h.local),
      update: h.update.mockImplementation(async (_id: string, changes: Record<string, unknown>) => { Object.assign(h.local, changes); }),
    },
  },
}));

import { useRemoteWipeCommands } from '../../hooks/use-remote-unlock';

beforeEach(() => {
  vi.useFakeTimers();
  h.local = { deviceId: 'dev-1', githubRepo: 'owner/repo' };
  h.update.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

it('notes a rejected token, and clears the note once a poll works again', async () => {
  h.pollRemoteCommands.mockRejectedValueOnce(new Error('GitHub API error: 401'));
  h.pollRemoteCommands.mockResolvedValue({ etag: null, wiped: false });

  renderHook(() => useRemoteWipeCommands());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.local.remoteWipeTokenRejectedAt).toEqual(expect.any(Number));

  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.local.remoteWipeTokenRejectedAt).toBeUndefined();
});

it('a network blip notes nothing', async () => {
  h.pollRemoteCommands.mockRejectedValue(new TypeError('Failed to fetch'));
  renderHook(() => useRemoteWipeCommands());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.update).not.toHaveBeenCalled();
});
