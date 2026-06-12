import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, unlockWithPassphrase, lock, configureMaxUnlockAttempts,
  isParanoidEnabled, isUnlocked, getLastUnlockFailure, __resetVaultStateForTests,
} from '../../db/vault';
import type { Task } from '../../db/models';

const PASS = 'attempt wipe passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  const now = Date.now();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
});

afterEach(async () => {
  __resetVaultStateForTests();
  localStorage.clear();
  try { await db.open(); } catch { /* may have been deleted by a wipe */ }
});

describe('failed-attempt wipe', () => {
  it('counts wrong attempts (persisted) and resets on a successful unlock', async () => {
    await enableParanoid(PASS);
    await configureMaxUnlockAttempts(0); // disable the wipe for this test
    lock();

    expect(await unlockWithPassphrase('nope')).toBe(false);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(1);
    expect(await unlockWithPassphrase('still wrong')).toBe(false);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(2);

    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(0);
  });

  it('counts every concurrent wrong attempt without racing the counter (ACR-009)', async () => {
    await enableParanoid(PASS);
    await configureMaxUnlockAttempts(0); // isolate the counter from the wipe tripwire
    lock();

    // Fire several wrong unlocks at once. Serialized read-modify-write means the
    // stored counter advances once per attempt (before the fix they could collapse).
    const results = await Promise.all([
      unlockWithPassphrase('w1'),
      unlockWithPassphrase('w2'),
      unlockWithPassphrase('w3'),
      unlockWithPassphrase('w4'),
    ]);
    expect(results).toEqual([false, false, false, false]);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(4);
  });

  it('does not leave the DEK resident when vault secrets are corrupt (ACR-008)', async () => {
    await enableParanoid(PASS);
    lock();
    // Corrupt the encrypted secrets blob so post-verifier validation fails.
    await db.vault.update('vault', { secrets: 'not-valid-ciphertext' });
    expect(await unlockWithPassphrase(PASS)).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('a corrupt vault with the CORRECT passphrase burns no attempts and never trips the wipe', async () => {
    await enableParanoid(PASS);
    await configureMaxUnlockAttempts(1); // hair trigger: any counted failure would wipe
    lock();
    await db.vault.update('vault', { secrets: 'not-valid-ciphertext' });

    expect(await unlockWithPassphrase(PASS)).toBe(false);
    expect(getLastUnlockFailure()).toBe('corrupt-vault');

    // The verifier proved the passphrase right — no attempt counted, no wipe fired.
    const vault = await db.vault.get('vault');
    expect(vault).toBeDefined();
    expect(vault?.failedUnlockAttempts ?? 0).toBe(0);
    expect(await db.tasks.count()).toBe(1);
  });

  it('reports wrong-credential for an actually wrong passphrase', async () => {
    await enableParanoid(PASS);
    await configureMaxUnlockAttempts(0);
    lock();

    expect(await unlockWithPassphrase('nope')).toBe(false);
    expect(getLastUnlockFailure()).toBe('wrong-credential');
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(1);

    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect(getLastUnlockFailure()).toBeNull();
  });

  it('wipes local data after the configured number of failed attempts', async () => {
    await enableParanoid(PASS);
    await configureMaxUnlockAttempts(3);
    lock();

    expect(await unlockWithPassphrase('a')).toBe(false);
    expect(await unlockWithPassphrase('b')).toBe(false);
    expect(isParanoidEnabled()).toBe(true); // survives the first two

    // The 3rd consecutive failure trips the panic wipe.
    expect(await unlockWithPassphrase('c')).toBe(false);

    await db.open(); // panicWipe closed + deleted the DB; reopen to inspect
    expect(await db.vault.get('vault')).toBeUndefined();
    expect(await db.tasks.count()).toBe(0);
    expect(isParanoidEnabled()).toBe(false); // paranoid flag wiped from localStorage
    expect(isUnlocked()).toBe(false);
  });
});
