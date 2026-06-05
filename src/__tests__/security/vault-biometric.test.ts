import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithPrf,
  addBiometric, removeBiometric, isUnlocked, getVaultSnapshot,
  __resetVaultStateForTests,
} from '../../db/vault';
import { installWebAuthnMock, uninstallWebAuthnMock, setWebAuthnMode } from '../helpers/webauthn-mock';
import type { Task } from '../../db/models';

const PASSPHRASE = 'biometric test passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-bio');
  installWebAuthnMock();
  const now = Date.now();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'secret task', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
});

afterEach(() => {
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-bio');
});

describe('vault biometric (PRF) unlock', () => {
  it('enrolls a biometric, then unlocks with it after lock', async () => {
    await enableParanoid(PASSPHRASE);
    await addBiometric();
    expect(getVaultSnapshot().hasBiometric).toBe(true);

    // Persisted material is present on the vault row.
    const vault = await db.vault.get('vault');
    expect(vault?.dekWrappedByPrf).toBeTruthy();
    expect(vault?.webauthnCredentialId).toBeTruthy();

    lock();
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPrf()).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('secret task');
  });

  it('addBiometric requires the vault to be unlocked', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    await expect(addBiometric()).rejects.toThrow(/Unlock the vault/);
  });

  it('unlockWithPrf returns false when no biometric is enrolled', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    expect(await unlockWithPrf()).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('a different authenticator output fails; passphrase still works', async () => {
    await enableParanoid(PASSPHRASE);
    await addBiometric();
    lock();

    setWebAuthnMode('wrong-output');
    expect(await unlockWithPrf()).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('a cancelled biometric prompt falls back (returns false), passphrase unlocks', async () => {
    await enableParanoid(PASSPHRASE);
    await addBiometric();
    lock();

    setWebAuthnMode('cancel');
    expect(await unlockWithPrf()).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
  });

  it('removeBiometric drops the enrolled credential', async () => {
    await enableParanoid(PASSPHRASE);
    await addBiometric();
    await removeBiometric();

    expect(getVaultSnapshot().hasBiometric).toBe(false);
    const vault = await db.vault.get('vault');
    expect(vault?.dekWrappedByPrf).toBeUndefined();
    expect(vault?.webauthnCredentialId).toBeUndefined();

    lock();
    expect(await unlockWithPrf()).toBe(false);
  });

  it('disabling paranoid mode clears the biometric flag', async () => {
    await enableParanoid(PASSPHRASE);
    await addBiometric();
    const { disableParanoid } = await import('../../db/vault');
    await disableParanoid();
    expect(getVaultSnapshot().hasBiometric).toBe(false);
  });
});
