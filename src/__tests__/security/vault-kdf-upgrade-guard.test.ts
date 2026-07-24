import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { wrapDek, generateDek } from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, unlockWithPassphrase, isUnlocked, lock,
  setSecondaryPassphrase, __resetVaultStateForTests,
} from '../../db/vault';
import { getErrorLog, clearErrorLog } from '../../lib/diagnostics';

const PASS = 'a genuinely complex passphrase 9!x';
const DURESS = 'another equally complex phrase 7?z';

const realDerive = vaultKdf.deriveVaultKek;

// Reproduce the production CSP incident: WebAssembly is blocked, so every
// Argon2id derivation throws while PBKDF2 (pure WebCrypto) keeps working.
// (vi.spyOn on the module namespace, not vi.mock: the spy is what vault.ts's
// own imported binding goes through.)
function breakArgon2(): void {
  vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(
    (pass: string, salt: string, kdf: KdfParams) =>
      kdf.algo === 'argon2id'
        ? Promise.reject(new Error("WebAssembly.compile(): blocked by CSP 'script-src'"))
        : realDerive(pass, salt, kdf),
  );
}

// Same hand-crafted legacy vault as vault-kdf.test.ts: PBKDF2 wrap, no kdf field.
async function craftLegacyVault(): Promise<void> {
  const dek = await generateDek();
  const passSalt = generateSalt();
  const legacyKek = await deriveKey(PASS, passSalt);
  await db.vault.put({
    id: 'vault',
    dekWrappedByPass: await wrapDek(legacyKek, dek),
    passSalt,
    verifier: await createVerifier(dek),
    secrets: await encryptBlob(dek, JSON.stringify({})),
    idleTimeoutMinutes: 15,
    migrationState: 'done',
  });
  localStorage.setItem('gtd25-paranoid', '1');
  __resetVaultStateForTests();
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  clearErrorLog();
  localStorage.removeItem('gtd25-paranoid');
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('vault flows when the Argon2id KDF cannot run (WASM blocked)', () => {
  it('a failed Argon2id re-wrap never turns a successful PBKDF2 unlock into an error', async () => {
    await craftLegacyVault();
    breakArgon2();

    await expect(unlockWithPassphrase(PASS)).resolves.toBe(true);
    expect(isUnlocked()).toBe(true);

    // The upgrade failed (recorded), the vault stays legacy and fully usable.
    const vault = await db.vault.get('vault');
    expect(vault?.kdf?.algo ?? 'pbkdf2').toBe('pbkdf2');
    expect(getErrorLog().some((e) => e.context === 'vault.kdfUpgrade')).toBe(true);

    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect(await unlockWithPassphrase('wrong')).toBe(false);
  });

  it('setSecondaryPassphrase fails with a clear message and a diagnostics entry', async () => {
    await enableParanoid(PASS); // argon2 works during setup -> vault.kdf = argon2id
    breakArgon2();

    await expect(setSecondaryPassphrase(DURESS)).rejects.toThrow(/up to date/);
    expect(getErrorLog().some((e) => e.context === 'vault.setSecondaryPassphrase')).toBe(true);
  });
});
