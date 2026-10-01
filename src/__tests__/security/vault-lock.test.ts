import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked,
  getDEK, getVaultSecrets, touchVaultActivity, setRuntimeIdleTimeoutMs, lockIfIdleExpired,
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

  it('setRuntimeIdleTimeoutMs updates the value WITHOUT re-arming the pending timer', async () => {
    await enableParanoid(PASSPHRASE);
    __setIdleTimeoutMsForTests(40);        // arms a 40ms idle timer
    setRuntimeIdleTimeoutMs(10 * 60_000);  // change value only — must not reset the 40ms countdown
    await delay(90);
    expect(isUnlocked()).toBe(false);      // the original 40ms timer still fired (no re-arm)
  });

  // Timers run on a clock that stands still while the machine sleeps: a Mac woken
  // after hours came back unlocked, and the first click re-armed a full window.
  describe('time spent asleep (the wall clock moves, timers do not)', () => {
    const sleepFor = (ms: number) => {
      const wokeAt = Date.now() + ms;
      vi.spyOn(Date, 'now').mockReturnValue(wokeAt);
    };
    afterEach(() => { vi.restoreAllMocks(); });

    it('the first interaction after sleeping past the window locks instead of re-arming', async () => {
      await enableParanoid(PASSPHRASE); // 15-minute window
      sleepFor(3 * 60 * 60_000);
      touchVaultActivity();
      expect(isUnlocked()).toBe(false);
    });

    it('lockIfIdleExpired locks once the window has run out on the wall clock', async () => {
      await enableParanoid(PASSPHRASE);
      lockIfIdleExpired();
      expect(isUnlocked()).toBe(true);
      sleepFor(16 * 60_000);
      lockIfIdleExpired();
      expect(isUnlocked()).toBe(false);
    });

    it('a pause inside the window changes nothing', async () => {
      await enableParanoid(PASSPHRASE);
      sleepFor(5 * 60_000);
      lockIfIdleExpired();
      touchVaultActivity();
      expect(isUnlocked()).toBe(true);
    });
  });

  it('records unlock timestamps only while relaxed unlock is enabled', async () => {
    await enableParanoid(PASSPHRASE);

    // Disabled by default: an unlock must not record anything.
    lock();
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect((await db.localSettings.get('local'))?.unlockHistory ?? []).toEqual([]);

    // Enabled: each successful unlock appends a timestamp.
    await db.localSettings.update('local', { relaxedUnlockEnabled: true });
    lock();
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    const hist = (await db.localSettings.get('local'))?.unlockHistory ?? [];
    expect(hist).toHaveLength(1);
    expect(typeof hist[0]).toBe('number');
  });
});
