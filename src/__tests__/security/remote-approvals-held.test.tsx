// @vitest-environment jsdom
//
// On the trusted device: Deny on a request that had already run out paused that
// device's requests for 10 minutes, and the next — real — request was then
// dropped without a word on either side (the locked device just showed its code).
// Now an expired request only closes, a paused device's request is held back as a
// line with "Show request", and the update prompt waits for unlock requests.
import { renderHook, waitFor, act } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  approveRemoteUnlock: vi.fn(async () => undefined),
  readPendingApproval: vi.fn(async () => null as unknown),
  listApprovedDevices: vi.fn(async () => [] as Array<{ deviceId: string; name: string }>),
  recordRemoteDenial: vi.fn(async () => undefined),
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
  cancelRemoteUnlock: vi.fn(),
  expirePendingUnlock: vi.fn(async () => undefined),
  hasPendingUnlock: vi.fn(() => false),
  refreshRegistryHeartbeat: vi.fn(async () => false),
  pollApproverInbox: vi.fn(async () => 0),
  listApprovedDevices: h.listApprovedDevices,
  readPendingApproval: h.readPendingApproval,
  approveRemoteUnlock: h.approveRemoteUnlock,
  publishOwnRegistryEntry: vi.fn(async () => false),
  dropDecommissionedDevices: vi.fn(async () => []),
  recordRemoteDenial: h.recordRemoteDenial,
}));
vi.mock('../../db/vault', () => ({ isRemoteUnlockEnrolled: vi.fn(async () => true) }));
vi.mock('../../db/paranoid-flag', () => ({ isParanoidFlagSet: () => h.paranoid }));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));
vi.mock('../../lib/diagnostics', () => ({ recordError: h.recordError }));
vi.mock('../../db', () => ({
  db: { localSettings: { get: vi.fn(async () => ({ deviceId: 'dev-1', githubPat: 'ghp_token', githubRepo: 'owner/repo' })) } },
}));

import { useRemoteApprovals } from '../../hooks/use-remote-unlock';
import { useUpdatesHeldForApprovals, setApprovalState, APPROVAL_CHECK_GRACE_MS, __resetApprovalGateForTests } from '../../lib/approval-gate';

const MIN = 60_000;

function request(over: Record<string, unknown> = {}) {
  return {
    fromDeviceId: 'lap', fromName: 'Laptop', nonce: 'n-1', code: '123456',
    requestDigest: 'digest', expiresAt: Date.now() + 2 * MIN, ...over,
  };
}

function useBoth() {
  return { approvals: useRemoteApprovals(), updatesHeld: useUpdatesHeldForApprovals() };
}

/** Another approver tick, as the 12 s poll would run it. */
async function tickAgain(): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event('online')); });
}

beforeEach(() => {
  Object.values(h).forEach((v) => (v as { mockReset?: () => void }).mockReset?.());
  h.approveRemoteUnlock.mockResolvedValue(undefined);
  h.recordRemoteDenial.mockResolvedValue(undefined);
  h.listApprovedDevices.mockResolvedValue([{ deviceId: 'lap', name: 'Laptop' }]);
  h.readPendingApproval.mockResolvedValue(null);
  h.paranoid = false;
  __resetApprovalGateForTests('idle');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a request from a device declined a moment ago', () => {
  it('is held back as a line, not the prompt — and "Show request" brings it up', async () => {
    h.readPendingApproval.mockResolvedValue(request({ heldUntil: Date.now() + 8 * MIN }));
    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.held?.nonce).toBe('n-1'));
    expect(result.current.pending).toBeNull();

    act(() => result.current.showHeld());
    expect(result.current.pending).toMatchObject({ nonce: 'n-1', code: '123456' });
    expect(result.current.held).toBeNull();
  });

  it('once shown, that pause no longer holds its requests back', async () => {
    const heldUntil = Date.now() + 8 * MIN;
    h.readPendingApproval.mockResolvedValue(request({ heldUntil }));
    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.held).not.toBeNull());
    act(() => result.current.showHeld());
    await act(async () => { await result.current.approve(); });
    expect(result.current.pending).toBeNull();

    h.readPendingApproval.mockResolvedValue(request({ nonce: 'n-2', heldUntil }));
    await tickAgain();
    await waitFor(() => expect(result.current.pending?.nonce).toBe('n-2'));
    expect(result.current.held).toBeNull();
  });

  it('"Ignore" drops that request without a denial, and it does not come back', async () => {
    h.readPendingApproval.mockResolvedValue(request({ heldUntil: Date.now() + 8 * MIN }));
    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.held).not.toBeNull());

    act(() => result.current.ignoreHeld());
    expect(result.current.held).toBeNull();
    await tickAgain();
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.held).toBeNull();
    expect(result.current.pending).toBeNull();
    expect(h.recordRemoteDenial).not.toHaveBeenCalled();
  });

  it('a held request that is gone (answered elsewhere, expired) goes from the screen', async () => {
    h.readPendingApproval.mockResolvedValue(request({ heldUntil: Date.now() + 8 * MIN }));
    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.held).not.toBeNull());

    h.readPendingApproval.mockResolvedValue(null);
    await tickAgain();
    await waitFor(() => expect(result.current.held).toBeNull());
  });
});

describe('a request that ran out while the screen was off (its timer stood still)', () => {
  async function shownThenAsleep() {
    h.readPendingApproval.mockResolvedValue(request());
    const rendered = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(rendered.result.current.pending).not.toBeNull());
    vi.useFakeTimers({ toFake: ['Date'] }); // only the wall clock moves
    vi.setSystemTime(Date.now() + 5 * MIN);
    return rendered;
  }

  it('Deny only closes it: no denial, no pause for the next request', async () => {
    const { result } = await shownThenAsleep();
    act(() => result.current.deny());
    expect(result.current.pending).toBeNull();
    expect(h.recordRemoteDenial).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Unlock request from “Laptop” expired', 'info');
  });

  it('Approve sends nothing', async () => {
    const { result } = await shownThenAsleep();
    await act(async () => { await result.current.approve(); });
    expect(h.approveRemoteUnlock).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it('it closes as soon as the app is back in view', async () => {
    const { result } = await shownThenAsleep();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current.pending).toBeNull();
  });

  it('control: Deny on a live request records the denial', async () => {
    h.readPendingApproval.mockResolvedValue(request());
    const { result } = renderHook(() => useRemoteApprovals());
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => result.current.deny());
    expect(h.recordRemoteDenial).toHaveBeenCalledWith('lap');
  });
});

describe('the update prompt waits for unlock requests', () => {
  it('while the app looks for them, then not when there is none', async () => {
    let answer: (v: unknown) => void = () => {};
    h.readPendingApproval.mockReturnValue(new Promise((r) => { answer = r; }));
    const { result } = renderHook(() => useBoth());
    expect(result.current.updatesHeld).toBe(true);

    await act(async () => { answer(null); });
    await waitFor(() => expect(result.current.updatesHeld).toBe(false));
  });

  it('while a request is on screen, and no longer once it is answered', async () => {
    h.readPendingApproval.mockResolvedValue(request());
    const { result } = renderHook(() => useBoth());
    await waitFor(() => expect(result.current.approvals.pending).not.toBeNull());
    expect(result.current.updatesHeld).toBe(true);

    act(() => result.current.approvals.deny());
    expect(result.current.updatesHeld).toBe(false);
  });

  it('not for a held-back request\'s line (it sits above the update; a flood of them must not block updates)', async () => {
    h.readPendingApproval.mockResolvedValue(request({ heldUntil: Date.now() + 8 * MIN }));
    const { result } = renderHook(() => useBoth());
    await waitFor(() => expect(result.current.approvals.held).not.toBeNull());
    await waitFor(() => expect(result.current.updatesHeld).toBe(false));

    act(() => result.current.approvals.showHeld()); // asked to see it: now it is the prompt
    expect(result.current.updatesHeld).toBe(true);
  });

  it('coming back to the app after a while looks again first', async () => {
    const { result } = renderHook(() => useBoth());
    await waitFor(() => expect(result.current.updatesHeld).toBe(false));

    let answer: (v: unknown) => void = () => {};
    h.readPendingApproval.mockReturnValue(new Promise((r) => { answer = r; }));
    vi.useFakeTimers({ toFake: ['Date'] });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    vi.setSystemTime(Date.now() + 5 * MIN);
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.updatesHeld).toBe(true);
    await act(async () => { answer(null); });
    await waitFor(() => expect(result.current.updatesHeld).toBe(false));
  });

  it('a Paranoid device (never an approver) holds nothing', async () => {
    h.paranoid = true;
    const { result } = renderHook(() => useBoth());
    await waitFor(() => expect(result.current.updatesHeld).toBe(false));
    expect(h.readPendingApproval).not.toHaveBeenCalled();
  });

  it('a look that does not finish holds the update for the grace period only', async () => {
    vi.useFakeTimers();
    setApprovalState('checking');
    const { result } = renderHook(() => useUpdatesHeldForApprovals());
    expect(result.current).toBe(true);
    await act(async () => { vi.advanceTimersByTime(APPROVAL_CHECK_GRACE_MS + 10); });
    expect(result.current).toBe(false);
  });

  it('nothing is held once the approver is gone', async () => {
    let answer: (v: unknown) => void = () => {};
    h.readPendingApproval.mockReturnValue(new Promise((r) => { answer = r; }));
    const { result, unmount } = renderHook(() => useBoth());
    expect(result.current.updatesHeld).toBe(true);
    unmount();
    const after = renderHook(() => useUpdatesHeldForApprovals());
    expect(after.result.current).toBe(false);
    answer(null);
  });
});
