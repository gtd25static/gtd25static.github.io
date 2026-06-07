import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithSecurityKey,
  addSecurityKey, removeSecurityKey, listSecurityKeys, isUnlocked, getVaultSnapshot,
  __resetVaultStateForTests,
} from '../../db/vault';
import { installWebAuthnMock, uninstallWebAuthnMock, setWebAuthnMode, setNextCredentialId } from '../helpers/webauthn-mock';
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

    // Persisted material is in the multi-key array; legacy single fields unused.
    const vault = await db.vault.get('vault');
    expect(vault?.securityKeys?.length).toBe(1);
    expect(vault?.securityKeys?.[0].dekWrappedByPrf).toBeTruthy();
    expect(vault?.securityKeys?.[0].credentialId).toBeTruthy();
    expect(vault?.dekWrappedByPrf).toBeUndefined();
    expect(vault?.webauthnCredentialId).toBeUndefined();

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

describe('multiple security keys', () => {
  it('enrolls two keys with labels and unlocks with the enrolled set', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey('YubiKey');
    await addSecurityKey('Phone');

    const keys = await listSecurityKeys();
    expect(keys.map((k) => k.label).sort()).toEqual(['Phone', 'YubiKey']);
    // Distinct credentials, all wrapped under the one shared prfSalt.
    expect(new Set(keys.map((k) => k.credentialId)).size).toBe(2);

    lock();
    expect(await unlockWithSecurityKey()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('secret task');
  });

  it('removing one key by id keeps the other working', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey('YubiKey');
    await addSecurityKey('Phone');

    const [first] = await listSecurityKeys();
    await removeSecurityKey(first.credentialId);

    const remaining = await listSecurityKeys();
    expect(remaining.length).toBe(1);
    expect(remaining[0].credentialId).not.toBe(first.credentialId);
    expect(getVaultSnapshot().hasSecurityKey).toBe(true);

    lock();
    expect(await unlockWithSecurityKey()).toBe(true);
  });

  it('removing the last key falls back to the passphrase', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey('only key');
    const [only] = await listSecurityKeys();
    await removeSecurityKey(only.credentialId);

    expect(await listSecurityKeys()).toEqual([]);
    expect(getVaultSnapshot().hasSecurityKey).toBe(false);

    lock();
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
  });

  it('re-enrolling the same credential refreshes rather than duplicates', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey('Key');
    // Force the next created credential to reuse the first one's id.
    const [first] = await listSecurityKeys();
    setNextCredentialId(first.credentialId);
    await addSecurityKey('Key renamed');
    const keys = await listSecurityKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].label).toBe('Key renamed');
  });

  it('normalizes a legacy single-credential vault and migrates it on next add', async () => {
    await enableParanoid(PASSPHRASE);
    await addSecurityKey('legacy');
    // Rewrite the row into the pre-multi-key shape (single legacy fields).
    const v = await db.vault.get('vault');
    const legacy = v!.securityKeys![0];
    await db.vault.update('vault', {
      securityKeys: undefined,
      webauthnCredentialId: legacy.credentialId,
      dekWrappedByPrf: legacy.dekWrappedByPrf,
    });

    // Legacy vault still unlocks and is surfaced as one enrolled key.
    const listed = await listSecurityKeys();
    expect(listed.length).toBe(1);
    expect(listed[0].credentialId).toBe(legacy.credentialId);

    lock();
    expect(await unlockWithSecurityKey()).toBe(true);

    // Adding a second key migrates the legacy entry into the array and clears
    // the legacy fields.
    await addSecurityKey('new');
    const migrated = await db.vault.get('vault');
    expect(migrated?.securityKeys?.length).toBe(2);
    expect(migrated?.webauthnCredentialId).toBeUndefined();
    expect(migrated?.dekWrappedByPrf).toBeUndefined();
  });
});
