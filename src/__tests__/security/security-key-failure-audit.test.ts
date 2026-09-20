// A wrong security key used to return false with no audit entry at all — the
// unlock log was tamper-evident for the passphrase only. It is now logged, but
// deliberately NOT counted toward the failed-attempt wipe: we cannot tell
// "someone presented a key that is not enrolled" from "an enrolled credential
// returned different PRF output", which is what a reset authenticator or a
// synced passkey evaluated on another device does. Counting it would let a
// flaky key destroy the database in a handful of presses of a button whose
// error text invites retrying — and the same release arms that wipe by default
// on vaults where it had been silently off.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });

import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithSecurityKey, addSecurityKey,
  configureMaxUnlockAttempts, __resetVaultStateForTests,
} from '../../db/vault';
import {
  installWebAuthnMock, uninstallWebAuthnMock, setWebAuthnMode,
} from '../helpers/webauthn-mock';

const PASSPHRASE = 'security key audit passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  installWebAuthnMock();
});
afterEach(() => {
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('a security key that answers but reconstructs no enrolled wrap', () => {
  it('is logged, and never advances the wipe tripwire', async () => {
    await enableParanoid(PASSPHRASE);
    await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
    await addSecurityKey();
    await configureMaxUnlockAttempts(3);
    lock();

    setWebAuthnMode('wrong-output');
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(await unlockWithSecurityKey()).toBe(false); // would have wiped at 3

    const log = (await db.localSettings.get('local'))?.unlockLog ?? [];
    expect(log.filter((e) => e.method === 'securityKey' && e.ok === false).length).toBe(3);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts ?? 0).toBe(0);
    // The database is still here — that is the whole point.
    expect(await db.vault.get('vault')).toBeTruthy();
  });

  it('a cancelled prompt is not even logged — it is not an attempt', async () => {
    await enableParanoid(PASSPHRASE);
    await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
    await addSecurityKey();
    lock();

    setWebAuthnMode('cancel');
    expect(await unlockWithSecurityKey()).toBe(false);

    const log = (await db.localSettings.get('local'))?.unlockLog ?? [];
    expect(log.some((e) => e.method === 'securityKey' && e.ok === false)).toBe(false);
  });
});
