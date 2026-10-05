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
import type { SharedItem } from '../db/models';
import {
  getBinaryFile, putBinaryFile, transferTimeoutMs,
  getRef, createRef, updateRef, getCommit, getTree, createTree, createCommit, createBlobBase64,
  type GitTreeEntry,
} from './github-api';
import { encryptBytes, decryptBytes, getCachedEncryptionKey } from './crypto';
import { getActiveAtRestKey } from '../db/vault-middleware';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { recordError } from '../lib/diagnostics';
import { MAX_SHARED_FOLDER_BYTES } from '../lib/constants';

const BLOB_DIR = 'gtd25-shared';
export const BLOB_BRANCH = 'gtd25-blobs';
export const KEEP_PATH = `${BLOB_DIR}/.gtd25-keep`;
export const blobPath = (blobId: string) => `${BLOB_DIR}/${blobId}`;

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// The placeholder that keeps the blob branch's tree non-empty. Neutral content:
// it travels in a request body, and it used to name the app and the feature.
export const KEEP_CONTENT_BASE64 = btoa('\n');

// Thrown when no sync key is available (sync not set up, or Paranoid vault locked).
// Callers surface this as "unlock / set up sync to open this item".
export class NoSyncKeyError extends Error {
  constructor() {
    super('NO_SYNC_KEY');
    this.name = 'NoSyncKeyError';
  }
}

async function requireSyncKey(): Promise<CryptoKey> {
  const key = getCachedEncryptionKey();
  if (key) return key;
  // Cache expired (idle / hidden tab): re-derive from the stored password
  // before giving up — restarting the app must never be the fix for an upload.
  // Dynamic import: sync-engine imports this module (compaction), so a static
  // import back would be a cycle.
  const { ensureEncryptionKey } = await import('./sync-engine');
  const ensured = await ensureEncryptionKey();
  if (!ensured) throw new NoSyncKeyError();
  return ensured;
}

interface Creds { pat: string; repo: string }

async function getCredentials(): Promise<Creds | null> {
  const local = await db.localSettings.get('local');
  // Sync switched off means no file traffic either — the same switch the sync
  // engine honours. Files already in the local cache still open.
  if (!local?.syncEnabled) return null;
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
export async function ensureBlobBranch(creds: Creds): Promise<void> {
  if (blobBranchEnsured) return;
  const head = await getRef(creds.pat, creds.repo, BLOB_BRANCH);
  if (head) { blobBranchEnsured = true; return; }
  const keepSha = await createBlobBase64(creds.pat, creds.repo, KEEP_CONTENT_BASE64);
  const treeSha = await createTree(creds.pat, creds.repo, [
    { path: KEEP_PATH, mode: '100644', type: 'blob', sha: keepSha },
  ]);
  const commitSha = await createCommit(creds.pat, creds.repo, {
    message: 'gtd25: init shared blobs branch', tree: treeSha, parents: [],
  });
  try {
    await createRef(creds.pat, creds.repo, BLOB_BRANCH, commitSha);
  } catch (err) {
    // Another device created it first — fine, it now exists. Anything else (a
    // dropped connection, a 5xx) used to pass for that too, and every upload of
    // the page's life then went to a branch that did not exist.
    if (!(await getRef(creds.pat, creds.repo, BLOB_BRANCH))) throw err;
  }
  blobBranchEnsured = true;
}

/** Tests only. */
export function __resetBlobBranchEnsuredForTests(): void {
  blobBranchEnsured = false;
}

/** The local copy is only a cache: failing to write it (storage full) must not fail
 *  an upload that reached GitHub, nor withhold a download that completed. */
async function cacheBlobLocalBestEffort(blobId: string, plaintext: Uint8Array): Promise<void> {
  try {
    await cacheBlobLocal(blobId, plaintext);
  } catch (err) {
    recordError('sharedBlobs.cacheWrite', err);
  }
}

// --- Binding a file's bytes to its id ---

/**
 * AES-GCM additional data for a shared file's bytes on the wire: its id. Without
 * it, whoever can write the repository could swap two files' bytes (or put a
 * deleted file's bytes back under another's name) and each would open as the
 * other; now that fails to decrypt instead.
 */
export function blobAad(blobId: string): Uint8Array {
  return new TextEncoder().encode(`sharedBlob:${blobId}`);
}

// --- Size padding on the wire ---
// A file's exact size, readable off its upload by anyone inspecting the traffic,
// says a lot about which file it is. Bytes are framed with their real length and
// zero-padded before encryption to a Padmé length (Nikitin et al., "Reducing
// Metadata Leakage from Encrypted Files and Communication with PURBs", 2019): the
// length then reveals O(log log n) bits, for at most 6.25% more bytes above the
// 4 KiB floor (3.1% from 64 KiB). Everything up to the floor — snippets, small
// files — uploads at the same size. Padded files carry their own AAD, so a build
// that predates padding fails to open one instead of showing the padding.

const MIN_PADDED_BYTES = 4096;
const LENGTH_PREFIX_BYTES = 4;

function padme(length: number): number {
  const exponent = 31 - Math.clz32(length); // floor(log2 length)
  const bitsOfExponent = 32 - Math.clz32(exponent); // floor(log2 exponent) + 1
  const step = 2 ** (exponent - bitsOfExponent);
  return Math.ceil(length / step) * step;
}

/** Length of the framed, padded plaintext for a file of `size` bytes. */
export function paddedLength(size: number): number {
  return padme(Math.max(MIN_PADDED_BYTES, size + LENGTH_PREFIX_BYTES));
}

function blobAadV2(blobId: string): Uint8Array {
  return new TextEncoder().encode(`sharedBlob:v2:${blobId}`);
}

/** Encrypt a shared file's bytes for the wire: framed, padded, bound to its id. */
export async function sealSharedBlob(key: CryptoKey, plaintext: Uint8Array, blobId: string): Promise<Uint8Array> {
  const framed = new Uint8Array(paddedLength(plaintext.length));
  new DataView(framed.buffer).setUint32(0, plaintext.length);
  framed.set(plaintext, LENGTH_PREFIX_BYTES);
  return encryptBytes(key, framed, blobAadV2(blobId));
}

/**
 * Open a shared file's bytes from the wire: padded (since 2026-10-04), bound to
 * its id without padding, or — written before 2026-10-03 — unbound. Older files
 * gain the padding and the binding at the next sync-password change, which
 * re-encrypts them all.
 */
export async function decryptSharedBlob(key: CryptoKey, bytes: Uint8Array, blobId: string): Promise<Uint8Array> {
  let framed: Uint8Array | null = null;
  try {
    framed = await decryptBytes(key, bytes, blobAadV2(blobId));
  } catch {
    // Not a padded file: try the older formats below.
  }
  if (framed) {
    const length = framed.length >= LENGTH_PREFIX_BYTES
      ? new DataView(framed.buffer, framed.byteOffset).getUint32(0)
      : Infinity;
    if (length > framed.length - LENGTH_PREFIX_BYTES) throw new Error('Shared file has an invalid length');
    return framed.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
  }
  try {
    return await decryptBytes(key, bytes, blobAad(blobId));
  } catch {
    return decryptBytes(key, bytes);
  }
}

// --- Local at-rest cache (DEK when Paranoid on, plaintext otherwise) ---

export async function cacheBlobLocal(blobId: string, plaintext: Uint8Array): Promise<void> {
  const dek = getActiveAtRestKey();
  // Fail closed like the at-rest middleware does for entity rows. `sharedBlobs`
  // is binary, so it isn't a middleware-handled table and gets no throw from it:
  // this is the equivalent check. Upload/download hold the sync key across
  // network I/O, so a lock landing in that await (idle, hotkey, lock-when-hidden
  // when the phone backgrounds the app mid-download) would otherwise write the
  // bytes here in plaintext. Skipping only loses the cache — the caller already
  // has its plaintext in memory, and the next unlock re-downloads.
  if (!dek && isParanoidFlagSet()) return;
  const data = dek ? await encryptBytes(dek, plaintext) : plaintext;
  await db.sharedBlobs.put({ id: blobId, data, cachedAt: Date.now() });
}

async function readBlobLocal(blobId: string): Promise<Uint8Array | null> {
  const row = await db.sharedBlobs.get(blobId);
  if (!row) return null;
  const dek = getActiveAtRestKey();
  // Locked on a Paranoid device the cache holds ciphertext (the enable migration
  // clears it, so there is no plaintext left over from before). Without the DEK
  // the bytes are unreadable, not plaintext — report a miss rather than hand
  // ciphertext back as if it were the file.
  if (!dek && isParanoidFlagSet()) return null;
  if (!dek) return row.data;
  try {
    return await decryptBytes(dek, row.data);
  } catch (err) {
    // Not under this key (a corrupt or stale entry): a miss, so the file is
    // downloaded again, rather than an error every time it is opened.
    recordError('sharedBlobs.readCache', err);
    await db.sharedBlobs.delete(blobId);
    return null;
  }
}

// --- Public API ---

/**
 * Whether uploadSharedBlob can currently succeed: sync credentials are present
 * AND the sync key has been derived+cached. Both come up asynchronously after a
 * cold start / unlock, so a caller running at startup (the share-target consume)
 * must wait for this before saving a file, or the upload throws.
 */
export async function canUploadSharedBlob(): Promise<boolean> {
  if ((await getCredentials()) === null) return false;
  if (getCachedEncryptionKey() !== null) return true;
  const { ensureEncryptionKey } = await import('./sync-engine');
  return (await ensureEncryptionKey()) !== null;
}

/**
 * Why a new blob can't be uploaded right now, or null when it can: no sync set
 * up at all, or sync set up but its key not derived yet (just after a start or
 * an unlock). Lets the UI say which instead of a generic failure.
 */
export async function sharedBlobBlocker(): Promise<'no-sync' | 'not-ready' | null> {
  if ((await getCredentials()) === null) return 'no-sync';
  return (await canUploadSharedBlob()) ? null : 'not-ready';
}

/** Encrypt + upload a new blob to the blob branch, and cache its plaintext locally. */
export async function uploadSharedBlob(blobId: string, plaintext: Uint8Array): Promise<void> {
  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = await requireSyncKey();
  const ciphertext = await sealSharedBlob(key, plaintext, blobId);
  await ensureBlobBranch(creds);
  await putBinaryFile(creds.pat, creds.repo, blobPath(blobId), ciphertext, undefined, undefined, BLOB_BRANCH);
  await cacheBlobLocalBestEffort(blobId, plaintext);
}

/** Time budget for downloading a file of `size` bytes (unknown: the folder cap). */
export function sharedBlobDownloadTimeoutMs(size?: number): number {
  return transferTimeoutMs(paddedLength(size ?? MAX_SHARED_FOLDER_BYTES) + 28);
}

/**
 * Return a blob's plaintext bytes — from the local cache, else download + cache.
 * `size` (the item's) sizes the download's time budget.
 */
export async function getSharedBlobBytes(blobId: string, size?: number): Promise<Uint8Array> {
  const cached = await readBlobLocal(blobId);
  if (cached) return cached;

  const creds = await getCredentials();
  if (!creds) throw new Error('Sync is not configured');
  const key = await requireSyncKey();
  // Prefer the blob branch; fall back to the default branch for any legacy blob
  // written before blobs moved to their own branch.
  const timeoutMs = sharedBlobDownloadTimeoutMs(size);
  let ciphertext = await getBinaryFile(creds.pat, creds.repo, blobPath(blobId), undefined, BLOB_BRANCH, timeoutMs);
  if (!ciphertext) ciphertext = await getBinaryFile(creds.pat, creds.repo, blobPath(blobId), undefined, undefined, timeoutMs);
  if (!ciphertext) throw new Error(`Blob ${blobId} not found on remote`);
  const plaintext = await decryptSharedBlob(key, ciphertext, blobId);
  await cacheBlobLocalBestEffort(blobId, plaintext);
  return plaintext;
}

async function bumpPendingBlobDeletes(): Promise<void> {
  // One transaction: two tabs deleting at once must each count.
  await db.transaction('rw', db.syncMeta, async () => {
    const meta = await db.syncMeta.get('sync-meta');
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: (meta?.pendingBlobDeletes ?? 0) + 1 });
  });
}

/**
 * Forget a deleted file's bytes on this device and flag the folder for
 * compaction. No request: the compaction after the next successful sync rebuilds
 * the blob branch without them — tip and history in one step, however many files
 * were deleted. (A per-file DELETE used to clean the tip only, which left the
 * compaction nothing to drop, so it never squashed and the deleted bytes stayed
 * reachable in the history.)
 */
export async function deleteSharedBlob(blobId: string): Promise<void> {
  await db.sharedBlobs.delete(blobId);
  await bumpPendingBlobDeletes();
}

const BLOB_BRANCH_LOCK = 'gtd25-blob-branch';

/**
 * Run `fn` holding this device's blob-branch lock (across tabs, through Web
 * Locks; as is where they don't exist). It serialises the writes that can undo
 * each other: an upload together with the write of its item, a compaction from
 * reading the live files to its forced ref update, a sync-password change's
 * rewrite, a wipe's purge. A compaction between an upload and its item would see
 * the new file with nothing naming it; one force-pushing between another's ref
 * re-read and update would undo that write.
 */
export async function withBlobBranchLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(BLOB_BRANCH_LOCK, fn) : fn();
}

/**
 * Blob ids of the live items — or null when any item row can't be read: a
 * locked vault hands back ciphertext, a failed decrypt a quarantined
 * placeholder, and such a row's file would look like garbage.
 */
export function readableLiveBlobIds(items: SharedItem[]): Set<string> | null {
  const live = new Set<string>();
  for (const item of items) {
    const row = item as SharedItem & { _enc?: unknown; _decryptError?: unknown };
    if (row._enc !== undefined || row._decryptError) return null;
    if (item.deletedAt) continue;
    if (item.type !== 'link' && !item.blobId) return null; // files and snippets have bytes
    if (item.blobId) live.add(item.blobId);
  }
  return live;
}

/**
 * Reclaim repo space: rebuild the blob branch as a single ORPHAN commit that keeps
 * only the live blobs (reusing their existing git blob SHAs — no re-upload), then
 * force-update the ref. All prior commits — every deleted/old blob — become
 * unreachable and GitHub GCs them on its own schedule.
 *
 * Safety: builds the keep-set from the branch's own tree, never dropping a blob in
 * `liveBlobIds` or one `spare` keeps; re-reads the ref just before the
 * force-update and aborts if the branch moved (a concurrent upload). GitHub has
 * no compare-and-swap on refs, so an upload from another device landing between
 * that re-read and the update is still lost — which is why routine runs rewrite
 * only when they drop something.
 *
 * `spare` is asked about each blob that is neither live nor the placeholder.
 * `squashHistory` (default on) also rewrites a branch whose tip holds nothing to
 * drop but which has history — where a file deleted from the tip by an older
 * version, one DELETE at a time, still lies.
 *
 * Returns the number of blob objects dropped from the tip tree (0 = nothing was
 * dropped, possibly after squashing history), or null when the run was skipped
 * (truncated listing, or the branch moved) and should be retried.
 */
export async function compactBlobBranch(
  creds: Creds,
  liveBlobIds: Set<string>,
  options: { spare?: (blobId: string) => boolean; squashHistory?: boolean } = {},
): Promise<number | null> {
  const { spare = () => false, squashHistory = true } = options;
  const head = await getRef(creds.pat, creds.repo, BLOB_BRANCH);
  if (!head) return 0;

  const { treeSha, parents } = await getCommit(creds.pat, creds.repo, head);
  const { entries, truncated } = await getTree(creds.pat, creds.repo, treeSha, true);
  if (truncated) {
    console.warn('Blob branch tree truncated — skipping compaction this round');
    return null;
  }

  const blobs = entries.filter((e) => e.type === 'blob' && e.path.startsWith(`${BLOB_DIR}/`));
  let keepFile = blobs.find((e) => e.path === KEEP_PATH);
  const kept = (e: GitTreeEntry) =>
    e.path === KEEP_PATH || liveBlobIds.has(basename(e.path)) || spare(basename(e.path));
  const keep = blobs.filter(kept);
  const dropped = blobs.length - keep.length;
  if (dropped === 0 && !(squashHistory && parents.length > 0)) return 0;

  // Guarantee a non-empty tree (e.g. the wipe case where liveBlobIds is empty).
  if (!keepFile) {
    const keepSha = await createBlobBase64(creds.pat, creds.repo, KEEP_CONTENT_BASE64);
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
    return null;
  }
  await updateRef(creds.pat, creds.repo, BLOB_BRANCH, newCommit, true);
  return dropped;
}

// Run a compaction at most this often when there are no fresh deletions to flush.
const BLOB_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
// After a failed run (force pushes refused, say), wait this long before the next
// rather than retrying after every sync.
const BLOB_COMPACTION_RETRY_MS = 60 * 60 * 1000; // 1h
// A blob no item here names is another device's upload until shown otherwise:
// its metadata follows within seconds — or whenever that device is next online.
// Dropped as garbage only once unknown this long; a file deleted here goes at once.
const UNKNOWN_BLOB_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Gated entry point called (fire-and-forget) at the end of a successful sync.
 * Compacts when this device has pending blob deletions, or periodically to sweep
 * garbage from deletions made on other devices. Stamps state after a completed
 * run (even if nothing was dropped) so we don't refetch the tree every sync; a
 * skipped run leaves the pending deletions in place for the next sync.
 */
export async function maybeCompactBlobBranch(pat: string, repo: string): Promise<void> {
  await withBlobBranchLock(() => compactIfDue({ pat, repo }));
}

async function compactIfDue(creds: Creds): Promise<void> {
  const meta = await db.syncMeta.get('sync-meta');
  const now = Date.now();
  const pending = meta?.pendingBlobDeletes ?? 0;
  if (pending === 0 && now - (meta?.lastBlobCompactionAt ?? 0) < BLOB_COMPACTION_INTERVAL_MS) return;
  if (now - (meta?.blobCompactionFailedAt ?? 0) < BLOB_COMPACTION_RETRY_MS) return;
  // A sync-password change in progress rewrites the branch itself.
  if (meta?.keyRotation) return;
  // Locked, the item rows are ciphertext: no blobId can be read and every file
  // would look dead. (A lock can land between the sync and this run.)
  if (isParanoidFlagSet() && !getActiveAtRestKey()) return;

  // Cheap local guard before any network: if this device knows of no shared items
  // and made no deletions, there's nothing authoritative to compact. (Runs only
  // after a successful sync, so an empty view means genuinely empty — never
  // "not yet pulled" — which also prevents an empty device from wiping the branch.)
  const items = await db.sharedItems.toArray();
  if (pending === 0 && items.length === 0) return;
  const live = readableLiveBlobIds(items);
  if (!live) return; // a row this device can't read: its file must not look dead

  const dead = new Set(items.filter((i) => i.deletedAt && i.blobId).map((i) => i.blobId!));
  const firstSeen = meta?.unknownBlobsSeenAt ?? {};
  const unknown: Record<string, number> = {};
  const spare = (blobId: string) => {
    if (dead.has(blobId)) return false;
    unknown[blobId] = firstSeen[blobId] ?? now;
    return now - unknown[blobId] < UNKNOWN_BLOB_GRACE_MS;
  };

  let result: number | null;
  try {
    result = await compactBlobBranch(creds, live, {
      spare,
      // History holds deleted bytes only where an older version deleted file by
      // file: sweep it once, then rewrite only when something is dropped.
      squashHistory: !meta?.blobHistorySweptAt,
    });
  } catch (err) {
    await db.syncMeta.update('sync-meta', { blobCompactionFailedAt: now });
    throw err;
  }
  if (result === null) return;
  // Clear only the deletions this run covered: one made while it ran was still
  // live when the keep-set was read, so it needs the next run.
  await db.transaction('rw', db.syncMeta, async () => {
    const current = (await db.syncMeta.get('sync-meta'))?.pendingBlobDeletes ?? 0;
    await db.syncMeta.update('sync-meta', {
      pendingBlobDeletes: Math.max(0, current - pending),
      lastBlobCompactionAt: now,
      blobHistorySweptAt: meta?.blobHistorySweptAt ?? now,
      blobCompactionFailedAt: undefined,
      unknownBlobsSeenAt: Object.fromEntries(
        Object.entries(unknown).filter(([, seenAt]) => now - seenAt < UNKNOWN_BLOB_GRACE_MS),
      ),
    });
  });
}
