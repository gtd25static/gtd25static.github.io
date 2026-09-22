// Pure key primitives for the Paranoid Mode vault (no stateful side effects).
//
// Key hierarchy: a random data-encryption key (DEK) is wrapped by a
// key-encryption key (KEK) derived from a passphrase (Argon2id, legacy PBKDF2),
// from a WebAuthn PRF output, or handed over as a remote-unlock key. The same
// DEK can be wrapped multiple times so any method unlocks it.
//
// Every wrap is bound to the slot it lives in (AES-GCM additional data), so a
// wrap moved to another slot of the vault row fails to open there, instead of
// changing what the passphrase that opens it means: swapping the two passphrase
// slots used to turn the real passphrase into the secondary one and vice versa.
// Wraps written before the binding existed (the raw DEK as base64 text, no
// additional data) still open from any slot; vault.ts rewrites each one bound
// the next time it holds the KEK that opens it.

import { encryptBlob, decryptBlob, encryptBytes, decryptBytes } from '../sync/crypto';

/** Where a wrap lives; each slot has its own binding. */
export type WrapSlot = 'slot1' | 'slot2' | 'ruk' | `prf:${string}`;

// A pre-binding wrap: iv || AES-GCM(the 44-char base64 text of the 32-byte DEK) || tag.
// A bound wrap encrypts the 32 raw bytes instead, so the two never share a length.
const LEGACY_WRAP_BYTES = 12 + 44 + 16;

const te = new TextEncoder();
function slotAad(slot: WrapSlot): Uint8Array {
  return te.encode(`gtd25-vault:${slot}`);
}

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
  return importDekBytes(base64ToBytes(rawBase64));
}

function importDekBytes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/** True for a wrap written before slot binding existed (opens from any slot). */
export function isLegacyWrap(wrapped: string): boolean {
  return base64ToBytes(wrapped).length === LEGACY_WRAP_BYTES;
}

/**
 * Wrap the DEK with a KEK, bound to `slot` -> base64(iv||ciphertext), safe to
 * persist. Without a slot it writes the pre-binding format (only tests do that,
 * to seed the vaults of older builds).
 */
export async function wrapDek(kek: CryptoKey, dek: CryptoKey, slot?: WrapSlot): Promise<string> {
  if (!slot) return encryptBlob(kek, await exportDekRaw(dek));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  try {
    return bytesToBase64(await encryptBytes(kek, raw, slotAad(slot)));
  } finally {
    raw.fill(0);
  }
}

/**
 * Unwrap a wrapped-DEK blob with the KEK. Rejects if the KEK is wrong (AES-GCM
 * auth), or if a bound wrap sits in a slot it was not written for. A pre-binding
 * wrap opens from any slot.
 */
export async function unwrapDek(kek: CryptoKey, wrapped: string, slot?: WrapSlot): Promise<CryptoKey> {
  const bytes = base64ToBytes(wrapped);
  if (bytes.length === LEGACY_WRAP_BYTES) return importDekRaw(await decryptBlob(kek, wrapped));
  if (!slot) throw new Error('A bound wrap needs its slot to open');
  const raw = await decryptBytes(kek, bytes, slotAad(slot));
  try {
    return await importDekBytes(raw);
  } finally {
    raw.fill(0);
  }
}

/**
 * A correctly-sized, unremovable garbage slot-2 blob (a throwaway DEK wrapped by
 * a throwaway KEK, bound to slot 2): no user passphrase can unwrap it, and it is
 * byte-shaped like a real secondary-passphrase wrap, so slot 2's contents never
 * reveal whether one is set up.
 */
export async function generateGarbageSlot(): Promise<string> {
  const [kek, dek] = await Promise.all([
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
    generateDek(),
  ]);
  return wrapDek(kek, dek, 'slot2');
}

/** Import 32 raw bytes (e.g. a WebAuthn PRF output) as an AES-GCM KEK. */
export function importKekFromBytes(raw: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
