// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import '../setup-component';

// A nudge is computed from rows decrypted while unlocked. One that was still
// being computed when the vault locked used to be shown anyway — an OS
// notification quoting a real title after the lock had closed them all, and a
// dialog waiting for the next unlock, even a secondary-passphrase one, where it
// named a real task over the placeholder content (threat-model review).

const h = vi.hoisted(() => ({
  unlocked: true,
  lockDuringRead: false,
  showNotification: vi.fn(),
  showFocusNudge: vi.fn(),
}));

vi.mock('../../db/vault', () => ({
  isParanoidEnabled: () => true,
  isUnlocked: () => h.unlocked,
}));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ locked: !h.unlocked }) }));
vi.mock('../../hooks/use-settings', () => ({
  useLocalSettings: () => ({ nudgesEnabled: true }),
  updateLocalSettings: vi.fn(async () => undefined),
}));
vi.mock('../../lib/nudges', () => ({
  shouldNudgeNow: () => true,
  computeNudge: () => ({ kind: 'overdue', title: 'Overdue task', body: '“REAL TITLE” is overdue.', taskId: 't1' }),
}));
vi.mock('../../lib/notifications', () => ({ showNudgeNotification: h.showNotification }));
vi.mock('../../stores/focus-nudge', () => ({ showFocusNudge: h.showFocusNudge }));
vi.mock('../../db', () => ({
  db: {
    localSettings: { get: async () => ({ id: 'local' }) },
    tasks: {
      toArray: async () => {
        if (h.lockDuringRead) h.unlocked = false; // the lock lands mid-computation
        return [];
      },
    },
    taskLists: { toArray: async () => [] },
    subtasks: { toArray: async () => [] },
  },
}));

import { useNudges } from '../../hooks/use-nudges';

beforeEach(() => {
  h.unlocked = true;
  h.lockDuringRead = false;
  h.showNotification.mockClear();
  h.showFocusNudge.mockClear();
  Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted' } });
});

describe('useNudges', () => {
  it('shows the nudge while unlocked (control)', async () => {
    renderHook(() => useNudges());
    await waitFor(() => expect(h.showFocusNudge).toHaveBeenCalled());
    expect(h.showNotification).toHaveBeenCalled();
  });

  it('drops a nudge whose computation the lock overtook', async () => {
    h.lockDuringRead = true;
    renderHook(() => useNudges());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.showNotification).not.toHaveBeenCalled();
    expect(h.showFocusNudge).not.toHaveBeenCalled();
  });
});
