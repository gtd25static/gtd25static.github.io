import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked, getDEK, startCrossTabLock,
  __resetVaultStateForTests,
} from '../../db/vault';
import { __resetTabChannelForTests } from '../../lib/tab-channel';

const PASSPHRASE = 'cross tab passphrase';
const CHANNEL_NAME = 'gtd25-tabs';
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A second tab of the app, seen from this one. */
function otherTab() {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post: (signal: unknown) => channel.postMessage(signal),
    heard: [] as unknown[],
    listen() {
      channel.addEventListener('message', (e) => this.heard.push((e as MessageEvent).data));
      return this;
    },
    close: () => channel.close(),
  };
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.removeItem('gtd25-paranoid');
  await db.localSettings.update('local', { githubPat: 'ghp_secret', encryptionPassword: 'syncpw' });
});

afterEach(() => {
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('cross-tab vault lock', () => {
  it('locks this tab when another tab locks', async () => {
    const stop = startCrossTabLock();
    await enableParanoid(PASSPHRASE);
    expect(isUnlocked()).toBe(true);

    otherTab().post({ type: 'lock' });
    await settle();

    expect(isUnlocked()).toBe(false);
    expect(getDEK()).toBeNull();
    stop();
  });

  it('locks this tab when another tab wipes', async () => {
    const stop = startCrossTabLock();
    await enableParanoid(PASSPHRASE);

    otherTab().post({ type: 'wipe' });
    await settle();

    expect(isUnlocked()).toBe(false);
    stop();
  });

  it('tells the other tabs when this one locks', async () => {
    const other = otherTab().listen();
    await enableParanoid(PASSPHRASE);

    lock();
    await settle();

    expect(other.heard).toEqual([{ type: 'lock' }]);
    other.close();
  });

  it('never unlocks from a signal — no message can open a locked vault', async () => {
    // The channel is deliberately lock-only: an unlock would mean moving the DEK
    // between contexts. Anything that claims otherwise must be inert.
    const stop = startCrossTabLock();
    await enableParanoid(PASSPHRASE);
    lock();
    expect(isUnlocked()).toBe(false);

    const other = otherTab();
    other.post({ type: 'unlock' });
    other.post({ type: 'lock', unlock: true });
    other.post({ type: 'wipe', dek: 'anything' });
    await settle();

    expect(isUnlocked()).toBe(false);
    expect(getDEK()).toBeNull();
    // …and a real unlock still works afterwards.
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    stop();
    other.close();
  });

  it('stays locked after re-locking — a lock signal is idempotent', async () => {
    const stop = startCrossTabLock();
    await enableParanoid(PASSPHRASE);
    const other = otherTab();

    other.post({ type: 'lock' });
    other.post({ type: 'lock' });
    await settle();

    expect(isUnlocked()).toBe(false);
    stop();
    other.close();
  });
});
