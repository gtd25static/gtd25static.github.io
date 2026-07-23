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
// Backend layout: blobs live on a DEDICATED ORPHAN BRANCH `gtd25-blobs` at path
// `gtd25-shared/{blobId}` (random id, no extension — no filename/type leak; blobId
// itself is encrypted in the item metadata). Keeping blobs off the default branch
// lets us reclaim space by periodically history-squashing this branch (see
// `compactBlobBranch`) without ever rewriting the user's task/snapshot history.

import { db } from '../db';
import {
  getBinaryFile, putBinaryFile, getFileSha, deleteFile,
  getRef, createRef, updateRef, getCommit, getTree, createTree, createCommit, createBlobBase64,
  type GitTreeEntry,
} from './github-api';
import { encryptBytes, decryptBytes, getCachedEncryptionKey } from './crypto';
import { getActiveAtRestKey } from '../db/vault-middleware';

const BLOB_DIR = 'gtd25-shared';
export const BLOB_BRANCH = 'gtd25-blobs';
const KEEP_PATH = `${BLOB_DIR}/.gtd25-keep`;
export const blobPath = (blobId: string) => `${BLOB_DIR}/${blobId}`;

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

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

interface Creds { pat: string; repo: string }

async function getCredentials(): Promise<Creds | null> {
  const local = await db.localSettings.get('local');
  // When Paranoid is on the PAT lives in the vault; read it the same way sync does.
  const { isParanoidFlagSet } = await import('../db/paranoid-flag');
  const { getVaultSecrets } = await import('../db/vault');
  const pat = isParanoidFlagSet() ? getVaultSecrets()?.githubPat : local?.githubPat;
  if (!pat || !local?.githubRepo) return null;
  return { pat, repo: local.githubRepo };
}

// --- Blob branch bootstrap ---

let blobBranchEnsured = false;

// Create the orphan `gtd25-blobs` branch on first use (a single root commit with a
// `.gtd25-keep` placeholder so the branch always has a tree). Idempotent.
async function ensureBlobBranch(creds: Creds): Promise<void> {
  if (blobBranchEnsured) return;
  const head = await getRef(creds.pat, creds.repo, BLOB_BRANCH);
  if (head) { blobBranchEnsured = true; return; }
  const keepSha = await createBlobBase64(creds.pat, creds.repo, btoa('gtd25 shared folder blobs'));
  const treeSha = await createTree(creds.pat, creds.repo, [
    { path: KEEP_PATH, mode: '100644', type: 'blob', sha: keepSha },
  ]);
  const commitSha = await createCommit(creds.pat, creds.repo, {
    message: 'gtd25: init shared blobs branch', tree: treeSha, parents: [],
  });
  try {
    await createRef(creds.pat, creds.repo, BLOB_BRANCH, commitSha);
  } catch {
    // Another device created it first — fine, it now exists.
  }
  blobBranchEnsured = true;
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

/**
 * Whether uploadSharedBlob can currently succeed: sync credentials are present
 * AND the sync key has been derived+cached. Both come up asynchronously after a
 * cold start / unlock, so a caller running at startup (the share-target consume)
 * must wait for this before saving a file, or the upload throws.
 */
export async function canUploadSharedBlob(): Promise<boolean> {
  return (await getCredentials()) !== null && getCachedEncryptionKey() !== null;
}

/** Encrypt + upload a new blob to the blob branch, and cache its plaintext locally. */
export async function uploadSharedBlob(blobId: string, plaintext: Uint8Array): Promise<void> {
  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = requireSyncKey();
  const ciphertext = await encryptBytes(key, plaintext);
  await ensureBlobBranch(creds);
  await putBinaryFile(creds.pat, creds.repo, blobPath(blobId), ciphertext, undefined, undefined, BLOB_BRANCH);
  await cacheBlobLocal(blobId, plaintext);
}

/** Return a blob's plaintext bytes — from the local cache, else download + cache. */
export async function getSharedBlobBytes(blobId: string): Promise<Uint8Array> {
  const cached = await readBlobLocal(blobId);
  if (cached) return cached;

  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = requireSyncKey();
  // Prefer the blob branch; fall back to the default branch for any legacy blob
  // written before blobs moved to their own branch.
  let ciphertext = await getBinaryFile(creds.pat, creds.repo, blobPath(blobId), undefined, BLOB_BRANCH);
  if (!ciphertext) ciphertext = await getBinaryFile(creds.pat, creds.repo, blobPath(blobId));
  if (!ciphertext) throw new Error(`Blob ${blobId} not found on remote`);
  const plaintext = await decryptBytes(key, ciphertext);
  await cacheBlobLocal(blobId, plaintext);
  return plaintext;
}

async function bumpPendingBlobDeletes(): Promise<void> {
  const meta = await db.syncMeta.get('sync-meta');
  await db.syncMeta.update('sync-meta', { pendingBlobDeletes: (meta?.pendingBlobDeletes ?? 0) + 1 });
}

/**
 * Remove a blob from the blob branch tip and the local cache, and flag the folder
 * for history compaction. Best-effort on remote (the metadata tombstone still
 * syncs; the next compaction purges the bytes from history regardless).
 */
export async function deleteSharedBlob(blobId: string): Promise<void> {
  await db.sharedBlobs.delete(blobId);
  await bumpPendingBlobDeletes();
  const creds = await getCredentials();
  if (!creds) return;
  try {
    const sha = await getFileSha(creds.pat, creds.repo, blobPath(blobId), undefined, BLOB_BRANCH);
    if (sha) await deleteFile(creds.pat, creds.repo, blobPath(blobId), sha, undefined, BLOB_BRANCH);
  } catch (err) {
    // Non-fatal: compaction will drop it from history even if this tip removal fails.
    console.warn(`Failed to delete shared blob ${blobId}:`, err);
  }
}

/**
 * Reclaim repo space: rebuild the blob branch as a single ORPHAN commit that keeps
 * only the live blobs (reusing their existing git blob SHAs — no re-upload), then
 * force-update the ref. All prior commits — every deleted/old blob — become
 * unreachable and GitHub GCs them on its own schedule.
 *
 * Safety: builds the keep-set from the branch's own tree, never dropping a blob in
 * `liveBlobIds`; re-reads the ref just before the force-update and aborts if the
 * branch moved (a concurrent upload), so a racing upload is never clobbered.
 *
 * Returns the number of blob objects dropped from the tip tree (0 = nothing to do).
 */
export async function compactBlobBranch(creds: Creds, liveBlobIds: Set<string>): Promise<number> {
  const head = await getRef(creds.pat, creds.repo, BLOB_BRANCH);
  if (!head) return 0;

  const { treeSha } = await getCommit(creds.pat, creds.repo, head);
  const { entries, truncated } = await getTree(creds.pat, creds.repo, treeSha, true);
  if (truncated) {
    console.warn('Blob branch tree truncated — skipping compaction this round');
    return 0;
  }

  const blobs = entries.filter((e) => e.type === 'blob' && e.path.startsWith(`${BLOB_DIR}/`));
  let keepFile = blobs.find((e) => e.path === KEEP_PATH);
  const liveOrKeep = (e: GitTreeEntry) => e.path === KEEP_PATH || liveBlobIds.has(basename(e.path));
  const keep = blobs.filter(liveOrKeep);
  const dropped = blobs.length - keep.length;
  if (dropped === 0) return 0;

  // Guarantee a non-empty tree (e.g. the wipe case where liveBlobIds is empty).
  if (!keepFile) {
    const keepSha = await createBlobBase64(creds.pat, creds.repo, btoa('gtd25 shared folder blobs'));
    keepFile = { path: KEEP_PATH, mode: '100644', type: 'blob', sha: keepSha };
    keep.push(keepFile);
  }

  const newTree = await createTree(
    creds.pat, creds.repo,
    keep.map((e) => ({ path: e.path, mode: e.mode, type: 'blob' as const, sha: e.sha })),
  );
  const newCommit = await createCommit(creds.pat, creds.repo, {
    message: 'gtd25: compact shared blobs', tree: newTree, parents: [],
  });

  // Concurrency guard: only force-update if no one pushed to the branch meanwhile.
  const head2 = await getRef(creds.pat, creds.repo, BLOB_BRANCH);
  if (head2 !== head) {
    console.warn('Blob branch changed during compaction — skipping force-update');
    return 0;
  }
  await updateRef(creds.pat, creds.repo, BLOB_BRANCH, newCommit, true);
  return dropped;
}

// Run a compaction at most this often when there are no fresh deletions to flush.
const BLOB_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Gated entry point called (fire-and-forget) at the end of a successful sync.
 * Compacts when this device has pending blob deletions, or periodically to sweep
 * garbage from deletions made on other devices. Stamps state after a successful
 * attempt (even if nothing was dropped) so we don't refetch the tree every sync.
 */
export async function maybeCompactBlobBranch(pat: string, repo: string): Promise<void> {
  const meta = await db.syncMeta.get('sync-meta');
  const now = Date.now();
  const pending = meta?.pendingBlobDeletes ?? 0;
  const last = meta?.lastBlobCompactionAt ?? 0;
  if (pending === 0 && now - last < BLOB_COMPACTION_INTERVAL_MS) return;

  // Cheap local guard before any network: if this device knows of no shared items
  // and made no deletions, there's nothing authoritative to compact. (Runs only
  // after a successful sync, so an empty view means genuinely empty — never
  // "not yet pulled" — which also prevents an empty device from wiping the branch.)
  const itemCount = await db.sharedItems.count();
  if (pending === 0 && itemCount === 0) return;

  const items = await db.sharedItems.toArray();
  const live = new Set<string>();
  for (const it of items) if (!it.deletedAt && it.blobId) live.add(it.blobId);

  await compactBlobBranch({ pat, repo }, live);
  await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 0, lastBlobCompactionAt: now });
}
