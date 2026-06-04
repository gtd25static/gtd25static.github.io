// Pure key primitives for the Paranoid Mode vault (no stateful side effects).
//
// Key hierarchy: a random data-encryption key (DEK) is wrapped by a
// key-encryption key (KEK). The KEK is derived from a passphrase (PBKDF2) or,
// in PR3, from a WebAuthn PRF output. The same DEK can be wrapped multiple
// times so either method unlocks it.

import { encryptBlob, decryptBlob } from '../sync/crypto';

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Fresh random AES-256-GCM data-encryption key. Extractable so it can be wrapped. */
export function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportDekRaw(dek: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', dek);
  return bytesToBase64(new Uint8Array(raw));
}

export function importDekRaw(rawBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(rawBase64) as BufferSource, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/** Wrap the DEK with a KEK -> base64(iv||ciphertext) blob, safe to persist. */
export async function wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<string> {
  return encryptBlob(kek, await exportDekRaw(dek));
}

/** Unwrap a wrapped-DEK blob with the KEK. Rejects if the KEK is wrong (AES-GCM auth). */
export async function unwrapDek(kek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return importDekRaw(await decryptBlob(kek, wrapped));
}

/** Import 32 raw bytes (e.g. a WebAuthn PRF output) as an AES-GCM KEK. */
export function importKekFromBytes(raw: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
