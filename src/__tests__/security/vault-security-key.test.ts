import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithSecurityKey,
  addSecurityKey, removeSecurityKey, isUnlocked, getVaultSnapshot,
  __resetVaultStateForTests,
} from '../../db/vault';
import { installWebAuthnMock, uninstallWebAuthnMock, setWebAuthnMode } from '../helpers/webauthn-mock';
import type { Task } from '../../db/models';

const PASSPHRASE = 'security key test passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
  installWebAuthnMock();
  const now = Date.now();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'secret task', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
});

afterEach(() => {
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
});

describe('vault security key (PRF) unlock', () => {
  it('enrolls a security key, then unlocks with it after lock', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey();
    expect(getVaultSnapshot().hasSecurityKey).toBe(true);

    // Persisted material is present on the vault row.
    const vault = await db.vault.get('vault');
    expect(vault?.dekWrappedByPrf).toBeTruthy();
    expect(vault?.webauthnCredentialId).toBeTruthy();

    lock();
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithSecurityKey()).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('secret task');
  });

  it('addSecurityKey requires the vault to be unlocked', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    await expect(addSecurityKey()).rejects.toThrow(/Unlock the vault/);
  });

  it('unlockWithSecurityKey returns false when no security key is enrolled', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('a different authenticator output fails; passphrase still works', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey();
    lock();

    setWebAuthnMode('wrong-output');
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('a cancelled security key prompt falls back (returns false), passphrase unlocks', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey();
    lock();

    setWebAuthnMode('cancel');
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
  });

  it('removeSecurityKey drops the enrolled credential', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey();
    await removeSecurityKey();

    expect(getVaultSnapshot().hasSecurityKey).toBe(false);
    const vault = await db.vault.get('vault');
    expect(vault?.dekWrappedByPrf).toBeUndefined();
    expect(vault?.webauthnCredentialId).toBeUndefined();

    lock();
    expect(await unlockWithSecurityKey()).toBe(false);
  });

  it('disabling paranoid mode clears the security key flag', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey();
    const { disableParanoid } = await import('../../db/vault');
    await disableParanoid();
    expect(getVaultSnapshot().hasSecurityKey).toBe(false);
  });
});
