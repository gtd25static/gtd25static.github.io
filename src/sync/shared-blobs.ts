// Shared Folder blob lifecycle.
//
// Two distinct crypto layers, applied separately — exactly mirroring how the rest
// of the app treats every entity:
//   - SYNC KEY on the wire: blob bytes are AES-GCM encrypted with the sync key
//     before upload and decrypted after download (E2E across the user's devices).
//   - DEK at rest: the local cache (`sharedBlobs`) holds DEK-encrypted bytes when
//     Paranoid Mode is on, plaintext when off — applied here because the
//     field-oriented vault middleware can't handle binary. This keeps the cache
//     within Paranoid's at-rest guarantee (Argon2id-wrapped DEK, not just the
//     PBKDF2 sync key).
//
// Backend layout: each blob is one opaque object at `gtd25-shared/{blobId}` with a
// random id and no extension — no filename or type leak. blobId itself is stored
// encrypted in the item metadata, so a backend observer can't link metadata to a
// blob object.

import { db } from '../db';
import { getBinaryFile, putBinaryFile, getFileSha, deleteFile } from './github-api';
import { encryptBytes, decryptBytes, getCachedEncryptionKey } from './crypto';
import { getActiveAtRestKey } from '../db/vault-middleware';

const BLOB_DIR = 'gtd25-shared';
export const blobPath = (blobId: string) => `${BLOB_DIR}/${blobId}`;

// Thrown when no sync key is available (sync not set up, or Paranoid vault locked).
// Callers surface this as "unlock / set up sync to open this item".
export class NoSyncKeyError extends Error {
  constructor() {
    super('NO_SYNC_KEY');
    this.name = 'NoSyncKeyError';
  }
}

function requireSyncKey(): CryptoKey {
  const key = getCachedEncryptionKey();
  if (!key) throw new NoSyncKeyError();
  return key;
}

async function getCredentials(): Promise<{ pat: string; repo: string } | null> {
  const local = await db.localSettings.get('local');
  // When Paranoid is on the PAT lives in the vault; read it the same way sync does.
  const { isParanoidFlagSet } = await import('../db/paranoid-flag');
  const { getVaultSecrets } = await import('../db/vault');
  const pat = isParanoidFlagSet() ? getVaultSecrets()?.githubPat : local?.githubPat;
  if (!pat || !local?.githubRepo) return null;
  return { pat, repo: local.githubRepo };
}

// --- Local at-rest cache (DEK when Paranoid on, plaintext otherwise) ---

export async function cacheBlobLocal(blobId: string, plaintext: Uint8Array): Promise<void> {
  const dek = getActiveAtRestKey();
  const data = dek ? await encryptBytes(dek, plaintext) : plaintext;
  await db.sharedBlobs.put({ id: blobId, data, cachedAt: Date.now() });
}

async function readBlobLocal(blobId: string): Promise<Uint8Array | null> {
  const row = await db.sharedBlobs.get(blobId);
  if (!row) return null;
  const dek = getActiveAtRestKey();
  return dek ? decryptBytes(dek, row.data) : row.data;
}

// --- Public API ---

/** Encrypt + upload a new blob, and cache its plaintext locally. */
export async function uploadSharedBlob(blobId: string, plaintext: Uint8Array): Promise<void> {
  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = requireSyncKey();
  const ciphertext = await encryptBytes(key, plaintext);
  await putBinaryFile(creds.pat, creds.repo, blobPath(blobId), ciphertext);
  await cacheBlobLocal(blobId, plaintext);
}

/** Return a blob's plaintext bytes — from the local cache, else download + cache. */
export async function getSharedBlobBytes(blobId: string): Promise<Uint8Array> {
  const cached = await readBlobLocal(blobId);
  if (cached) return cached;

  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = requireSyncKey();
  const ciphertext = await getBinaryFile(creds.pat, creds.repo, blobPath(blobId));
  if (!ciphertext) throw new Error(`Blob ${blobId} not found on remote`);
  const plaintext = await decryptBytes(key, ciphertext);
  await cacheBlobLocal(blobId, plaintext);
  return plaintext;
}

/** Remove a blob from the backend and the local cache. Best-effort on remote. */
export async function deleteSharedBlob(blobId: string): Promise<void> {
  await db.sharedBlobs.delete(blobId);
  const creds = await getCredentials();
  if (!creds) return;
  try {
    const sha = await getFileSha(creds.pat, creds.repo, blobPath(blobId));
    if (sha) await deleteFile(creds.pat, creds.repo, blobPath(blobId), sha);
  } catch (err) {
    // Non-fatal: the metadata is already soft-deleted; an orphaned blob can be
    // cleaned up on a later purge run.
    console.warn(`Failed to delete shared blob ${blobId}:`, err);
  }
}
