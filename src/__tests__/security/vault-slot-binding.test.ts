import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { installWebAuthnMock, uninstallWebAuthnMock, prfOutputFor } from '../helpers/webauthn-mock';
import { wrapDek, generateDek, isLegacyWrap, importKekFromBytes } from '../../db/vault-crypto';
import { deriveVaultKek, type KdfParams } from '../../db/vault-kdf';
import { generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithSecurityKey, unlockWithRemoteKey, isUnlocked,
  setSecondaryPassphrase, checkPassphrase, addSecurityKey, wrapDekWithRuk, __resetVaultStateForTests,
} from '../../db/vault';
import type { Task } from '../../db/models';

// Each wrap of the DEK is bound to the slot it lives in. Without that, anyone
// able to rewrite the vault row could swap the two passphrase slots and make the
// real passphrase behave as the secondary one and the secondary as the real one.

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';
// Same light parameters the suite installs via __setKdfParamsForTests.
const TEST_KDF: KdfParams = { algo: 'argon2id', memKiB: 1024, iterations: 1, parallelism: 1 };

async function seedTask() {
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'FIRE_THE_CFO on Monday', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
}

async function swapSlots() {
  const v = await db.vault.get('vault');
  await db.vault.update('vault', { dekWrappedByPass: v!.wrappedDek2, wrappedDek2: v!.dekWrappedByPass });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A vault as an older build wrote it: every wrap unbound. Rows stay plaintext (no key was active). */
async function seedLegacyVault(withSecondary: boolean): Promise<CryptoKey> {
  const dek = await generateDek();
  const passSalt = generateSalt();
  const kekMain = await deriveVaultKek(REAL, passSalt, TEST_KDF);
  const slot2 = withSecondary
    ? await wrapDek(await deriveVaultKek(SECONDARY, passSalt, TEST_KDF), dek)
    : await wrapDek(await importKekFromBytes(crypto.getRandomValues(new Uint8Array(32))), await generateDek());
  await db.vault.put({
    id: 'vault',
    dekWrappedByPass: await wrapDek(kekMain, dek),
    wrappedDek2: slot2,
    passSalt,
    kdf: TEST_KDF,
    prfSalt: generateSalt(),
    verifier: await createVerifier(dek),
    secrets: await encryptBlob(dek, JSON.stringify({})),
    idleTimeoutMinutes: 15,
    maxUnlockAttempts: 10,
    failedUnlockAttempts: 0,
    migrationState: 'done',
  });
  localStorage.setItem('gtd25-paranoid', '1');
  return dek;
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  installWebAuthnMock();
});

afterEach(() => {
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  localStorage.clear();
});

describe('a wrap moved to another slot does not open there', () => {
  it('swapping the two passphrase slots makes both passphrases fail, and re-keys nothing', async () => {
    await seedTask();
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    await swapSlots();

    // Before binding: the secondary opened the REAL content as a main unlock, and
    // the real passphrase ran the secondary path over it.
    expect(await unlockWithPassphrase(SECONDARY)).toBe(false);
    expect(await unlockWithPassphrase(REAL)).toBe(false);
    expect(isUnlocked()).toBe(false);
    expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(2); // tampering reads as wrong passphrases

    await swapSlots(); // put the row back: nothing was re-keyed meanwhile
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('FIRE_THE_CFO on Monday');
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });
});

describe('wraps written before binding', () => {
  it('slot 1 opens and is rewritten bound; slot 2 is left as it was', async () => {
    await seedLegacyVault(true);
    expect(await unlockWithPassphrase(REAL)).toBe(true);

    const vault = (await db.vault.get('vault'))!;
    expect(isLegacyWrap(vault.dekWrappedByPass)).toBe(false);
    expect(isLegacyWrap(vault.wrappedDek2!)).toBe(true);
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(true); // the bound wrap opens
  });

  it('a secondary passphrase set before binding keeps working after slot 1 was bound', async () => {
    await seedTask();
    await seedLegacyVault(true);
    expect(await unlockWithPassphrase(REAL)).toBe(true); // binds slot 1
    lock();

    expect(await unlockWithPassphrase(SECONDARY)).toBe(true); // slot 2 opened as before
    expect((await db.tasks.get('t1'))?.title).not.toContain('FIRE_THE_CFO'); // and did its job
    const vault = (await db.vault.get('vault'))!;
    expect(isLegacyWrap(vault.dekWrappedByPass)).toBe(false);
    expect(isLegacyWrap(vault.wrappedDek2!)).toBe(false);
  });

  it('a security-key wrap written before binding opens once, then is bound', async () => {
    await enableParanoid(REAL);
    await addSecurityKey();
    const vault = (await db.vault.get('vault'))!;
    const [key] = vault.securityKeys!;
    const dek = (await import('../../db/vault')).getDEK()!;
    const kek = await importKekFromBytes(prfOutputFor(base64ToBytes(vault.prfSalt!)));
    await db.vault.update('vault', { securityKeys: [{ ...key, dekWrappedByPrf: await wrapDek(kek, dek) }] });
    lock();

    expect(await unlockWithSecurityKey()).toBe(true);
    const after = (await db.vault.get('vault'))!;
    expect(isLegacyWrap(after.securityKeys![0].dekWrappedByPrf)).toBe(false);
    lock();
    expect(await unlockWithSecurityKey()).toBe(true);
  });

  it('a remote-unlock wrap written before binding opens once, then is bound', async () => {
    await enableParanoid(REAL);
    const ruk = crypto.getRandomValues(new Uint8Array(32));
    await wrapDekWithRuk(ruk);
    const dek = (await import('../../db/vault')).getDEK()!;
    await db.vault.update('vault', { dekWrappedByRuk: await wrapDek(await importKekFromBytes(ruk), dek) });
    lock();

    expect(await unlockWithRemoteKey(ruk)).toBe(true);
    expect(isLegacyWrap((await db.vault.get('vault'))!.dekWrappedByRuk!)).toBe(false);
    lock();
    expect(await unlockWithRemoteKey(ruk)).toBe(true);
  });
});
