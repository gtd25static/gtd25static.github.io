// Changing the sync password is a rotation of the key that covers everything in
// the repo, not a re-push of two files. Until 2026-09-22 it derived a new key and
// force-pushed the snapshot and an empty changelog under it — and left the Shared
// Folder blobs, the three tier backups, the migration backup (which the force
// push itself wrote, from the old snapshot) and the device registry's MACs under
// the old key: every shared file became unreadable on every device, and the old
// password kept opening what it had covered. This rotates all of it, in an order
// that survives an interruption at any point:
//
//   1. sync under the old key, so nothing pushed later is lost
//   2. pin the new salt (+ a verifier of the new key) in syncMeta.keyRotation, so
//      a retry rotates to the same key and refuses a different new password
//   3. rewrite every live shared blob under the new key, as ONE root commit of
//      the blob branch — nothing on the remote changes until its ref update
//   4. THE COMMIT POINT: cache the new key, store the new password, force-push
//      the snapshot under it (no old-key copy of the old snapshot is written)
//   5. drop the old-key migration backups, rewrite the tier backups, re-MAC this
//      device's registry entry, squash the default branch so the old-key history
//      is unreachable, forget the pin
//
// Interrupted before 4: the remote snapshot is as it was; after 3's ref update
// the blobs are under the new key and the snapshot under the old for the length
// of the gap (files fail to open until the retry, which finds them rotated).
// Interrupted after 4: the stored password is the new one, so a retry's pre-sync
// works under it and every later step is an overwrite. The other devices see the
// new salt on their next sync and ask for the new password (their stored one
// fails the verifier); anything they had not pushed by then is lost, which the
// settings dialog says before starting.

import { db } from '../db';
import type { SyncData } from '../db/models';
import { getVaultSecrets } from '../db/vault';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import {
  deleteFile, getFileSha, getBinaryFile, getRef, getCommit, getTree, createTree, createCommit,
  createBlobBase64, updateRef, type GitTreeEntry,
} from './github-api';
import {
  deriveKey, generateSalt, createVerifier, checkVerifier, encryptBytes, decryptBytes,
  cacheEncryptionKey, getCachedEncryptionKey, getCachedSalt,
} from './crypto';
import { syncNow, forcePush, endSyncSession, SYNC_LOCK_NAME } from './sync-engine';
import { hasPendingEntries } from './change-log';
import { getSyncPat, rememberSyncPassword, forgetSyncPassword } from './sync-credentials';
import { BLOB_BRANCH, KEEP_PATH, blobPath, ensureBlobBranch } from './shared-blobs';
import { overwriteAllBackups } from './remote-backups';
import { publishOwnRegistryEntry } from './remote-unlock';
import { squashDefaultBranch } from './history-compaction';
import { b64encode } from './remote-unlock-crypto';
import { SYNC_VERSION } from './version';
import { recordError } from '../lib/diagnostics';

export type RotationPhase = 'syncing' | 'files' | 'snapshot' | 'backups' | 'registry' | 'history';
export interface RotationProgress { phase: RotationPhase; done?: number; total?: number }
export interface RotationResult {
  blobsRewritten: number;
  /** Live shared files that neither key opened: kept as they were, still unreadable. */
  blobsUnreadable: number;
  historySquashed: boolean;
}

interface Creds { pat: string; repo: string }
interface Keys { newPassword: string; oldPassword: string | null; oldKey: CryptoKey; oldSalt: string }

async function currentSyncPassword(): Promise<string | null> {
  if (isParanoidFlagSet()) return getVaultSecrets()?.syncPassword ?? null;
  return (await db.localSettings.get('local'))?.encryptionPassword ?? null;
}

/** True while an earlier rotation is pinned but not finished (Settings shows a banner). */
export async function hasUnfinishedRotation(): Promise<boolean> {
  return !!(await db.syncMeta.get('sync-meta'))?.keyRotation;
}

/**
 * Forget an unfinished rotation's pin. The next password change then rotates to
 * a fresh key; a shared file already rewritten under the forgotten one stays
 * unreadable (counted, never dropped).
 */
export async function discardUnfinishedRotation(): Promise<void> {
  await db.syncMeta.update('sync-meta', { keyRotation: undefined });
}

export async function rotateSyncKey(
  newPassword: string,
  onProgress: (progress: RotationProgress) => void = () => {},
): Promise<RotationResult> {
  const local = await db.localSettings.get('local');
  const pat = await getSyncPat();
  if (!pat || !local?.githubRepo || !local.syncEnabled) throw new Error('Set up sync first');
  const creds: Creds = { pat, repo: local.githubRepo };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error("You're offline. Connect and try again.");
  }
  // Null when the key is held in memory only (the password prompt's "remember"
  // unticked): then a revert forgets the new password rather than restoring one.
  const oldPassword = await currentSyncPassword();

  // 1. Up to date under the old key: pulled, and nothing left to push.
  onProgress({ phase: 'syncing' });
  endSyncSession(); // remote entries cached under the old key must not be re-pushed
  if ((await syncNow(true)) < 0) {
    throw new Error('Could not sync before changing the password. Check the connection and try again.');
  }
  if (await hasPendingEntries()) {
    throw new Error('Some changes are not synced yet. Try again once the sync completes.');
  }
  const oldKey = getCachedEncryptionKey();
  const oldSalt = getCachedSalt();
  if (!oldKey || !oldSalt) throw new Error('The current sync key is not available. Sync once, then try again.');

  // Nobody else syncs this repo from this browser while the rotation runs.
  const keys: Keys = { newPassword, oldPassword, oldKey, oldSalt };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks
    ? locks.request(SYNC_LOCK_NAME, () => rotateHoldingLock(creds, keys, onProgress))
    : rotateHoldingLock(creds, keys, onProgress);
}

async function rotateHoldingLock(
  creds: Creds,
  { newPassword, oldPassword, oldKey, oldSalt }: Keys,
  onProgress: (progress: RotationProgress) => void,
): Promise<RotationResult> {
  // 2. The new key: pinned now, or the pin of an unfinished rotation.
  const pin = (await db.syncMeta.get('sync-meta'))?.keyRotation;
  const newSalt = pin?.newSalt ?? generateSalt();
  const newKey = await deriveKey(newPassword, newSalt);
  if (pin) {
    if (!(await checkVerifier(newKey, pin.newVerifier))) {
      throw new Error('A previous password change did not finish. Enter the same new password you chose then to complete it, or discard that change first.');
    }
  } else {
    await db.syncMeta.update('sync-meta', {
      keyRotation: { newSalt, newVerifier: await createVerifier(newKey), startedAt: Date.now() },
    });
  }

  // 3. The Shared Folder's files.
  onProgress({ phase: 'files' });
  const blobs = await rotateBlobBranch(creds, oldKey, newKey, onProgress);

  // 4. The commit point: from here on this device speaks the new key.
  onProgress({ phase: 'snapshot' });
  cacheEncryptionKey(newKey, newSalt);
  await rememberSyncPassword(newPassword);
  let encrypted: SyncData | null = null;
  try {
    encrypted = await forcePush({ backupExisting: false });
  } finally {
    if (!encrypted) {
      // Nothing was written: back to the old key, so this device stays in step
      // with the remote (and with the other devices) instead of asking for a
      // password the repo does not know yet.
      cacheEncryptionKey(oldKey, oldSalt);
      if (oldPassword) await rememberSyncPassword(oldPassword);
      else await forgetSyncPassword();
    }
  }
  if (!encrypted) throw new Error('The snapshot could not be rewritten under the new password. Nothing was changed; try again.');

  // 5. What else still carries the old key.
  onProgress({ phase: 'backups' });
  await deleteMigrationBackups(creds);
  await overwriteAllBackups(creds.pat, creds.repo, encrypted);
  onProgress({ phase: 'registry' });
  await publishOwnRegistryEntry(); // MAC under the new key; false when this device has none to publish
  onProgress({ phase: 'history' });
  let historySquashed = false;
  try {
    historySquashed = await squashDefaultBranch(creds.pat, creds.repo);
  } catch (err) {
    // The monthly squash gets it otherwise; say so in the result.
    recordError('keyRotation.squash', err);
  }
  await db.syncMeta.update('sync-meta', {
    ...(historySquashed ? { lastMainSquashAt: Date.now() } : {}),
    keyRotation: undefined,
  });
  return { ...blobs, historySquashed };
}

/** The migration backups force pushes write are copies of old snapshots under old keys. */
async function deleteMigrationBackups(creds: Creds): Promise<void> {
  for (let v = 0; v <= SYNC_VERSION; v++) {
    const path = `gtd25-snapshot-v${v}.backup.json`;
    try {
      const sha = await getFileSha(creds.pat, creds.repo, path);
      if (sha) await deleteFile(creds.pat, creds.repo, path, sha);
    } catch (err) {
      recordError('keyRotation.migrationBackup', err);
    }
  }
}

async function opensWith(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await decryptBytes(key, bytes);
  } catch {
    return null;
  }
}

/**
 * Rebuild the blob branch as one root commit whose live blobs are under the new
 * key. Every rewritten blob is uploaded as a dangling object first; the branch
 * changes in the single ref update at the end, or not at all. A blob already
 * under the new key (a retry) is kept; one neither key opens is kept and counted;
 * a legacy blob still on the default branch is moved here and dropped there.
 */
async function rotateBlobBranch(
  creds: Creds,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  onProgress: (progress: RotationProgress) => void,
): Promise<{ blobsRewritten: number; blobsUnreadable: number }> {
  const { pat, repo } = creds;
  const result = { blobsRewritten: 0, blobsUnreadable: 0 };
  const items = await db.sharedItems.toArray();
  const live = [...new Set(items.filter((i) => !i.deletedAt && i.blobId).map((i) => i.blobId!))];

  let head = await getRef(pat, repo, BLOB_BRANCH);
  if (!head) {
    if (live.length === 0) return result; // no branch, no files: nothing carries the old key
    await ensureBlobBranch(creds);
    head = await getRef(pat, repo, BLOB_BRANCH);
    if (!head) throw new Error('Could not create the shared-files branch');
  }
  const { treeSha, parents } = await getCommit(pat, repo, head);
  const { entries, truncated } = await getTree(pat, repo, treeSha, true);
  if (truncated) throw new Error('Too many shared files to re-encrypt in one go');
  const onBranch = new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e] as const));

  const keep = onBranch.get(KEEP_PATH);
  const tree: GitTreeEntry[] = [
    keep ?? { path: KEEP_PATH, mode: '100644', type: 'blob', sha: await createBlobBase64(pat, repo, btoa('gtd25 shared folder blobs')) },
  ];
  const legacyOnDefault: string[] = [];
  for (const [index, blobId] of live.entries()) {
    onProgress({ phase: 'files', done: index, total: live.length });
    const path = blobPath(blobId);
    const existing = onBranch.get(path);
    const bytes = existing
      ? await getBinaryFile(pat, repo, path, undefined, BLOB_BRANCH)
      : await getBinaryFile(pat, repo, path); // written before blobs had their own branch
    if (!bytes) continue; // not on the remote: nothing to carry over
    if (!existing) legacyOnDefault.push(path);
    const asIs = async (): Promise<GitTreeEntry> =>
      existing ?? { path, mode: '100644', type: 'blob', sha: await createBlobBase64(pat, repo, b64encode(bytes)) };
    if (await opensWith(newKey, bytes)) {
      tree.push(await asIs()); // already rotated (a retry)
      continue;
    }
    const plain = await opensWith(oldKey, bytes);
    if (!plain) {
      result.blobsUnreadable++;
      tree.push(await asIs());
      continue;
    }
    const sha = await createBlobBase64(pat, repo, b64encode(await encryptBytes(newKey, plain)));
    tree.push({ path, mode: '100644', type: 'blob', sha });
    result.blobsRewritten++;
  }

  // Nothing rewritten, nothing to move, no history to drop: leave the branch alone.
  if (result.blobsRewritten === 0 && legacyOnDefault.length === 0 && parents.length === 0) return result;

  const newTree = await createTree(pat, repo, tree);
  const commit = await createCommit(pat, repo, { message: 'gtd25: re-encrypt shared files', tree: newTree, parents: [] });
  if ((await getRef(pat, repo, BLOB_BRANCH)) !== head) {
    throw new Error('Shared files changed while they were being re-encrypted. Nothing was changed; try again.');
  }
  await updateRef(pat, repo, BLOB_BRANCH, commit, true);

  // The copies on the default branch are old-key ciphertext too; off the tip
  // now, out of history with the squash.
  for (const path of legacyOnDefault) {
    try {
      const sha = await getFileSha(pat, repo, path);
      if (sha) await deleteFile(pat, repo, path, sha);
    } catch (err) {
      recordError('keyRotation.legacyBlob', err);
    }
  }
  return result;
}
