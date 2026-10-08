import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, __resetVaultStateForTests } from '../../db/vault';
import * as syncEngine from '../../sync/sync-engine';
import { useAppState } from '../../stores/app-state';
import { useFocusNudgeStore, showFocusNudge } from '../../stores/focus-nudge';
import type { NudgeContent } from '../../lib/nudges';
import { startForgettingSessionOnLock } from '../../lib/forget-on-lock';

// The in-memory stores outlive the unlocked UI. Without this, the next unlock —
// possibly with the secondary passphrase, over placeholder content — got the last
// search text back ("No results for …") or a nudge dialog naming a real task, and
// a sync that was mid-flight kept its credentials and kept going.

const PASS = 'forget on lock passphrase 5 harbor';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  useAppState.getState().setSearchQuery('');
  useAppState.getState().setListFilter('');
  useFocusNudgeStore.getState().dismiss();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe("locking closes the app's notifications", () => {
  it('closes every notification the service worker is showing', async () => {
    const close = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: async () => ({ getNotifications: async () => [{ close }, { close }] }) },
    });
    const stop = startForgettingSessionOnLock();
    await enableParanoid(PASS);

    lock();
    await new Promise((r) => setTimeout(r, 20));

    expect(close).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('locking forgets the session', () => {
  it('clears the search text, the list filter, any pending nudge, and ends the sync session', async () => {
    const endSession = vi.spyOn(syncEngine, 'endSyncSession');
    const stop = startForgettingSessionOnLock();
    await enableParanoid(PASS);
    useAppState.getState().setSearchQuery('FIRE_THE_CFO');
    useAppState.getState().setListFilter('FIRE_THE_CFO');
    showFocusNudge({ kind: 'overdue', title: 'Overdue task', body: '“FIRE_THE_CFO” is overdue.', taskId: 't1' } as NudgeContent);

    lock();

    expect(useAppState.getState().searchQuery).toBe('');
    expect(useAppState.getState().listFilter).toBe('');
    expect(useFocusNudgeStore.getState().nudge).toBeNull();
    expect(endSession).toHaveBeenCalled();
    stop();
  });

  it('forgets unsent discussion notes (decrypted content kept outside the cards)', async () => {
    const stop = startForgettingSessionOnLock();
    await enableParanoid(PASS);
    useAppState.getState().setNoteDraft('t1', 'FIRE_THE_CFO');
    useAppState.getState().setNoteFocusTaskId('t1');

    lock();

    expect(useAppState.getState().noteDrafts).toEqual({});
    expect(useAppState.getState().noteFocusTaskId).toBeNull();
    stop();
  });

  it('control: while unlocked, nothing is forgotten', async () => {
    const stop = startForgettingSessionOnLock();
    await enableParanoid(PASS);
    useAppState.getState().setSearchQuery('still searching');

    expect(useAppState.getState().searchQuery).toBe('still searching');
    stop();
  });
});
