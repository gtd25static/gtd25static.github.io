// @vitest-environment jsdom
//
// Two failure modes in the human-facing half of the remote-unlock ceremony:
//
// 1. Abandoning a request (you asked a trusted device, then opened the vault with
//    the passphrase or a security key) left the ephemeral session key K resident
//    in the module for the rest of the page's life — across later locks — because
//    the only thing enforcing the TTL was a poll that stops with the lock screen.
// 2. The ACR-001 digest binding rejecting a swapped request told the approver
//    nothing, so an active substitution attack looked like a normal approval.
import { renderHook, waitFor, act } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  hasPendingUnlock: vi.fn(() => true),
  cancelRemoteUnlock: vi.fn(),
  expirePendingUnlock: vi.fn(async () => undefined),
  approveRemoteUnlock: vi.fn(async () => undefined),
  readPendingApproval: vi.fn(async () => null as unknown),
  listApprovedDevices: vi.fn(async () => [] as Array<{ deviceId: string; name: string }>),
  paranoid: false,
  toast: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock('../../sync/remote-unlock', () => ({
  getMailboxPat: vi.fn(async () => 'ghp_token'),
  getRepo: vi.fn(async () => 'owner/repo'),
  requestRemoteUnlock: vi.fn(),
  pollRemoteUnlock: vi.fn(async () => ({ etag: null, status: 'waiting' })),
  pollRemoteCommands: vi.fn(async () => undefined),
  cancelRemoteUnlock: h.cancelRemoteUnlock,
  expirePendingUnlock: h.expirePendingUnlock,
  hasPendingUnlock: h.hasPendingUnlock,
  pollApproverInbox: vi.fn(async () => undefined),
  listApprovedDevices: h.listApprovedDevices,
  readPendingApproval: h.readPendingApproval,
  approveRemoteUnlock: h.approveRemoteUnlock,
  publishOwnRegistryEntry: vi.fn(async () => undefined),
}));
vi.mock('../../db/vault', () => ({ isRemoteUnlockEnrolled: vi.fn(async () => true) }));
// The approver half only runs on a Paranoid-OFF device; the lock-screen half is
// indifferent to the flag, so one value serves both suites here.
vi.mock('../../db/paranoid-flag', () => ({ isParanoidFlagSet: () => h.paranoid }));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));
vi.mock('../../lib/diagnostics', () => ({ recordError: h.recordError }));
vi.mock('../../db', () => ({
  db: { localSettings: { get: vi.fn(async () => ({ deviceId: 'dev-1', githubPat: 'ghp_token', githubRepo: 'owner/repo' })) } },
}));

import { useLockScreenRemote, useRemoteApprovals } from '../../hooks/use-remote-unlock';

beforeEach(() => {
  Object.values(h).forEach((v) => (v as { mockClear?: () => void }).mockClear?.());
  h.hasPendingUnlock.mockReturnValue(true);
  h.listApprovedDevices.mockResolvedValue([]);
  h.readPendingApproval.mockResolvedValue(null);
  h.paranoid = false;
});

describe('abandoned unlock request', () => {
  it('zeroes the session key and clears the ceremony when the lock screen goes away', async () => {
    const { unmount } = renderHook(() => useLockScreenRemote());
    await waitFor(() => expect(h.hasPendingUnlock).not.toHaveBeenCalled()); // not yet — only on unmount

    unmount();

    expect(h.cancelRemoteUnlock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(h.expirePendingUnlock).toHaveBeenCalledWith('ghp_token', 'owner/repo', 'dev-1'));
  });

  it('does no remote cleanup when there was no request in flight', async () => {
    h.hasPendingUnlock.mockReturnValue(false);
    const { unmount } = renderHook(() => useLockScreenRemote());
    unmount();

    expect(h.cancelRemoteUnlock).not.toHaveBeenCalled();
    expect(h.expirePendingUnlock).not.toHaveBeenCalled();
  });
});

describe('approval rejected by the ACR-001 digest binding', () => {
  const approval = {
    fromName: 'Laptop', nonce: 'n-1', code: '123456',
    requestDigest: 'digest', expiresAt: Date.now() + 60_000,
  };

  function arrange(approveError: Error) {
    h.listApprovedDevices.mockResolvedValue([{ deviceId: 'dev-2', name: 'Laptop' }]);
    h.readPendingApproval.mockResolvedValue(approval);
    h.approveRemoteUnlock.mockRejectedValue(approveError);
  }

  it('tells the approver the request was swapped', async () => {
    arrange(new Error('Unlock request changed since it was shown — approval aborted'));

    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.pending).toBeTruthy());
    await act(async () => { await result.current.approve(); });

    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('Approval aborted'), 'error');
    expect(h.recordError).toHaveBeenCalledWith('remoteUnlock.approve', expect.any(Error));
  });

  it('still reports an ordinary network failure, without crying tamper', async () => {
    arrange(new Error('503 Service Unavailable'));

    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.pending).toBeTruthy());
    await act(async () => { await result.current.approve(); });

    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('Could not send the approval'), 'error');
  });
});
