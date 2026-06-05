// Vault key-derivation: turns the unlock passphrase into the KEK that wraps the
// DEK. Defaults to Argon2id (memory-hard, via hash-wasm) so brute-forcing the
// passphrase is expensive even on GPUs/ASICs. The chosen algorithm + parameters
// are recorded in the vault row (Vault.kdf) so we can verify-then-upgrade old
// vaults: a vault wrapped with the legacy PBKDF2 still unlocks, and is re-wrapped
// to Argon2id on the next successful unlock.
//
// NOTE: this is the *vault* KEK only (device-local). The *sync* encryption key
// stays PBKDF2 (src/sync/crypto.ts) — it is shared across devices and must remain
// wire-compatible.

import { argon2id } from 'hash-wasm';
import { deriveKey as pbkdf2DeriveKey } from '../sync/crypto';

export type KdfParams =
  | { algo: 'pbkdf2' }
  | { algo: 'argon2id'; memKiB: number; iterations: number; parallelism: number };

// ~0.5s on a typical laptop; 64 MiB forces real memory per guess, gutting GPU/ASIC
// parallelism. Tunable; the actual values used are persisted per-vault.
export const DEFAULT_ARGON2: KdfParams = {
  algo: 'argon2id',
  memKiB: 64 * 1024, // 64 MiB
  iterations: 3,
  parallelism: 1,
};

// Legacy vaults created before Argon2id carry no `kdf` field -> PBKDF2.
export const LEGACY_KDF: KdfParams = { algo: 'pbkdf2' };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Derive the vault KEK from the passphrase using the vault's recorded KDF. */
export async function deriveVaultKek(
  passphrase: string,
  saltBase64: string,
  kdf: KdfParams,
): Promise<CryptoKey> {
  if (kdf.algo === 'pbkdf2') {
    return pbkdf2DeriveKey(passphrase, saltBase64);
  }
  const raw = await argon2id({
    password: passphrase,
    salt: base64ToBytes(saltBase64),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memKiB, // hash-wasm takes KiB
    hashLength: 32,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
