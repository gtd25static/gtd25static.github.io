// @vitest-environment jsdom
//
// The locked device's half of a remote unlock (reliability review 2026-10-08):
// "Cancel request" left the request on the backend (the trusted devices kept
// showing it), and an approval with a key that no longer opens the vault was
// waited out in silence.
import { renderHook, waitFor, act } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  requestRemoteUnlock: vi.fn(async (..._a: unknown[]) => ({ code: '12-34' })),
  pollRemoteUnlock: vi.fn(async (..._a: unknown[]) => ({ etag: null, status: 'waiting' }) as Record<string, unknown>),
  expirePendingUnlock: vi.fn(async (..._a: unknown[]) => undefined),
  cancelRemoteUnlock: vi.fn(),
  order: [] as string[],
}));

vi.mock('../../sync/remote-unlock', () => ({
  getMailboxPat: vi.fn(async () => 'ghp_token'),
  getRepo: vi.fn(async () => 'owner/repo'),
  requestRemoteUnlock: h.requestRemoteUnlock,
  pollRemoteUnlock: h.pollRemoteUnlock,
  pollRemoteCommands: vi.fn(async () => undefined),
  cancelRemoteUnlock: h.cancelRemoteUnlock,
  expirePendingUnlock: h.expirePendingUnlock,
  hasPendingUnlock: vi.fn(() => false),
  refreshRegistryHeartbeat: vi.fn(async () => false),
  pollApproverInbox: vi.fn(async () => 0),
  listApprovedDevices: vi.fn(async () => []),
  readPendingApproval: vi.fn(async () => null),
  inspectPendingRequest: vi.fn(async () => null),
  approveRemoteUnlock: vi.fn(async () => undefined),
  publishOwnRegistryEntry: vi.fn(async () => false),
  dropDecommissionedDevices: vi.fn(async () => []),
  recordRemoteDenial: vi.fn(async () => undefined),
}));
vi.mock('../../db/vault', () => ({ isRemoteUnlockEnrolled: vi.fn(async () => true) }));
vi.mock('../../db/paranoid-flag', () => ({ isParanoidFlagSet: () => true }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));
vi.mock('../../db', () => ({
  db: { localSettings: { get: vi.fn(async () => ({ deviceId: 'lap-1', githubPat: 'ghp_token', githubRepo: 'owner/repo' })) } },
}));

import { useLockScreenRemote } from '../../hooks/use-remote-unlock';

beforeEach(() => {
  h.order = [];
  h.requestRemoteUnlock.mockClear();
  h.requestRemoteUnlock.mockImplementation(async () => { h.order.push('request'); return { code: '12-34' }; });
  h.pollRemoteUnlock.mockReset();
  h.pollRemoteUnlock.mockResolvedValue({ etag: null, status: 'waiting' });
  h.expirePendingUnlock.mockReset();
  h.expirePendingUnlock.mockResolvedValue(undefined);
  h.cancelRemoteUnlock.mockClear();
});

async function requested() {
  const rendered = renderHook(() => useLockScreenRemote());
  await waitFor(() => expect(rendered.result.current.enrolled).toBe(true));
  await act(async () => { await rendered.result.current.request(); });
  expect(rendered.result.current.code).toBe('12-34');
  return rendered;
}

it('an approval whose key no longer opens the vault is said — and the request keeps waiting for another device', async () => {
  h.pollRemoteUnlock.mockResolvedValue({ etag: 'e1', status: 'wrong-key', approverName: 'My Phone' });
  const { result } = await requested();
  await waitFor(() => expect(result.current.error).toMatch(/“My Phone” approved, but the key it holds no longer opens this vault/));
  expect(result.current.code).toBe('12-34');
});

it('"Cancel request" takes the request off the backend', async () => {
  const { result } = await requested();
  act(() => result.current.cancel());
  expect(result.current.code).toBeNull();
  expect(h.cancelRemoteUnlock).toHaveBeenCalled();
  expect(h.expirePendingUnlock).toHaveBeenCalledWith('ghp_token', 'owner/repo', 'lap-1');
});

it('a request right after a cancel waits for its cleanup (the late delete would take the new request)', async () => {
  let finishCleanup: () => void = () => {};
  h.expirePendingUnlock.mockImplementation(() => new Promise<undefined>((r) => {
    finishCleanup = () => { h.order.push('cleanup'); r(undefined); };
  }));
  const { result } = await requested();
  h.order = [];
  act(() => result.current.cancel());
  let again: Promise<void> = Promise.resolve();
  act(() => { again = result.current.request(); });
  await new Promise((r) => setTimeout(r, 20));
  expect(h.order).toEqual([]); // not yet: the cleanup is still running

  await act(async () => { finishCleanup(); await again; });
  expect(h.order).toEqual(['cleanup', 'request']);
});
