import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { deriveVaultKek } from '../../db/vault-kdf';
import { wrapDek, unwrapDek, generateDek, exportDekRaw } from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, unlockWithPassphrase, lock, isUnlocked, __resetVaultStateForTests,
} from '../../db/vault';
import type { Task } from '../../db/models';

const ARGON: { algo: 'argon2id'; memKiB: number; iterations: number; parallelism: number } =
  { algo: 'argon2id', memKiB: 1024, iterations: 1, parallelism: 1 };
const PASS = 'a genuinely complex passphrase 9!x';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});
afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('vault KDF (Argon2id)', () => {
  it('Argon2id-derived KEK wraps and unwraps the DEK; wrong passphrase fails', async () => {
    const dek = await generateDek();
    const salt = generateSalt();
    const kek = await deriveVaultKek(PASS, salt, ARGON);
    const wrapped = await wrapDek(kek, dek);
    expect(await exportDekRaw(await unwrapDek(kek, wrapped))).toBe(await exportDekRaw(dek));

    const wrongKek = await deriveVaultKek('not it', salt, ARGON);
    await expect(unwrapDek(wrongKek, wrapped)).rejects.toBeTruthy();
  });

  it('the same passphrase+salt is deterministic; pbkdf2 and argon2id differ', async () => {
    const salt = generateSalt();
    const a1 = await deriveVaultKek(PASS, salt, ARGON);
    const a2 = await deriveVaultKek(PASS, salt, ARGON);
    const dek = await generateDek();
    // Both KEKs unwrap a DEK wrapped by the other -> identical key material.
    const w = await wrapDek(a1, dek);
    expect(await exportDekRaw(await unwrapDek(a2, w))).toBe(await exportDekRaw(dek));

    // A pbkdf2 KEK on the same salt is a different key (won't unwrap the argon2 blob).
    const p = await deriveVaultKek(PASS, salt, { algo: 'pbkdf2' });
    await expect(unwrapDek(p, w)).rejects.toBeTruthy();
  });

  it('new vaults are stored with Argon2id', async () => {
    await enableParanoid(PASS);
    const vault = await db.vault.get('vault');
    expect(vault?.kdf?.algo).toBe('argon2id');
  });

  it('a legacy PBKDF2 vault still unlocks and is upgraded to Argon2id', async () => {
    // Hand-craft a legacy vault: DEK wrapped by a PBKDF2 KEK, no `kdf` field.
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'legacy', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);

    const dek = await generateDek();
    const passSalt = generateSalt();
    const legacyKek = await deriveKey(PASS, passSalt); // PBKDF2, as old builds did
    await db.vault.put({
      id: 'vault',
      dekWrappedByPass: await wrapDek(legacyKek, dek),
      passSalt,
      // no `kdf` field -> treated as legacy PBKDF2
      verifier: await createVerifier(dek),
      secrets: await encryptBlob(dek, JSON.stringify({})),
      idleTimeoutMinutes: 15,
      migrationState: 'done',
    });
    localStorage.setItem('gtd25-paranoid', '1');
    __resetVaultStateForTests();

    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect(isUnlocked()).toBe(true);

    // The vault was transparently re-wrapped to Argon2id...
    const upgraded = await db.vault.get('vault');
    expect(upgraded?.kdf?.algo).toBe('argon2id');

    // ...and still unlocks with the same passphrase after a re-lock.
    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect(await unlockWithPassphrase('wrong')).toBe(false);
  });
});
