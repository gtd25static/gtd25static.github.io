import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked,
  getDEK, getVaultSecrets, touchVaultActivity,
  __resetVaultStateForTests, __setIdleTimeoutMsForTests,
} from '../../db/vault';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PASSPHRASE = 'lock test passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  // Seed credentials so we can verify the secrets cache.
  await db.localSettings.update('local', { githubPat: 'ghp_secret', encryptionPassword: 'syncpw' });
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('vault lock/unlock', () => {
  it('caches credentials in memory while unlocked and clears them on lock', async () => {
    await enableParanoid(PASSPHRASE);
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_secret', syncPassword: 'syncpw' });
    expect(getDEK()).not.toBeNull();

    lock();
    expect(isUnlocked()).toBe(false);
    expect(getDEK()).toBeNull();
    expect(getVaultSecrets()).toBeNull();

    // Secrets come back after unlock (loaded from the encrypted vault row).
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_secret', syncPassword: 'syncpw' });
  });

  it('auto-locks after the idle timeout elapses', async () => {
    await enableParanoid(PASSPHRASE);
    __setIdleTimeoutMsForTests(40);

    expect(isUnlocked()).toBe(true);
    await delay(90);
    expect(isUnlocked()).toBe(false);
  });

  it('background DB reads do NOT defer the idle re-lock (ACR-002)', async () => {
    await enableParanoid(PASSPHRASE);
    __setIdleTimeoutMsForTests(150);

    // Two background reads (no user activity) through the vault middleware, which hits
    // the key provider. The key provider must not re-arm the idle timer, so the vault
    // still locks on schedule. (Before the fix each read reset the 150ms timer.)
    await delay(60);
    await db.tasks.toArray();
    await delay(60);
    await db.tasks.toArray();
    expect(isUnlocked()).toBe(true); // ~120ms < 150ms, still unlocked

    await delay(80); // ~200ms total with no user activity -> idle lock fires
    expect(isUnlocked()).toBe(false);
  });

  it('activity defers the idle re-lock', async () => {
    await enableParanoid(PASSPHRASE);
    __setIdleTimeoutMsForTests(120);

    await delay(70); // < 120ms, still unlocked
    expect(isUnlocked()).toBe(true);
    touchVaultActivity(); // re-arms the timer
    await delay(70); // 70ms since reset, still unlocked
    expect(isUnlocked()).toBe(true);
    await delay(90); // > 120ms since reset -> locked
    expect(isUnlocked()).toBe(false);
  });
});
