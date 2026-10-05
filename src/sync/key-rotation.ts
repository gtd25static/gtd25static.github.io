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
//   2. pin the new salt (+ a verifier of the new key) in syncMeta.keyRotation AND
//      on the remote (ROTATION_MARKER_FILE), so a retry — on this device or any
//      other — rotates to the same key and refuses a different new password
//   3. rewrite every live shared blob under the new key, as ONE root commit of
//      the blob branch — nothing on the remote changes until its ref update
//   4. THE COMMIT POINT: cache the new key, store the new password, force-push
//      the snapshot under it (no old-key copy of the old snapshot is written) and
//      carry the changelog over re-encrypted, so what other devices pushed during
//      step 3 is kept. A push that "fails" after its snapshot landed is
//      recognised by reading the remote back, and the rotation goes on.
//   5. drop the old-key migration backups and legacy blob copies, re-encrypt
//      each tier backup as it was, re-MAC the registry, drop the remote mark,
//      squash the default branch so the old-key history is unreachable, forget
//      the pin — kept if any of it failed, so the retry finishes it
//
// Interrupted before 4: the remote snapshot is as it was; after 3's ref update
// the blobs are under the new key and the snapshot under the old for the length
// of the gap (files fail to open until the retry, which finds them rotated — the
// error says so; it used to say "Nothing was changed"). The remote mark lets any
// device finish it with the same new password; without it, a password change
// started on another device counted every file unreadable and kept it so.
// Interrupted after 4: the stored password is the new one, so a retry's pre-sync
// works under it and every later step is an overwrite. The other devices see the
// new salt on their next sync and ask for the new password (their stored one
// fails the verifier). Residual: a file another device uploads under the old key
// between an interruption after 4 and the retry stays unreadable (the retry no
// longer has the old key).

import { db } from '../db';
import type { SyncData } from '../db/models';
import { getVaultSecrets } from '../db/vault';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import {
  deleteFile, getFile, putFile, getFileSha, getBinaryFile, getRef, getCommit, getTree, createTree, createCommit,
  createBlobBase64, updateRef, getDefaultBranch, type GitTreeEntry,
} from './github-api';
import {
  deriveKey, generateSalt, createVerifier, checkVerifier,
  cacheEncryptionKey, getCachedEncryptionKey, getCachedSalt,
} from './crypto';
import { syncNow, forcePush, endSyncSession, rekeyRemoteChangelog, SYNC_LOCK_NAME, SNAPSHOT_FILE } from './sync-engine';
import { isCompatibleVersion } from './version';
import { hasPendingEntries } from './change-log';
import { getSyncPat, rememberSyncPassword, forgetSyncPassword } from './sync-credentials';
import {
  BLOB_BRANCH, KEEP_PATH, KEEP_CONTENT_BASE64, blobPath, ensureBlobBranch, sealSharedBlob, decryptSharedBlob,
  sharedBlobDownloadTimeoutMs, paddedLength, withBlobBranchLock, readableLiveBlobIds,
} from './shared-blobs';
import { rekeyAllBackups } from './remote-backups';
import { publishOwnRegistryEntry, remacRegistry } from './remote-unlock';
import { squashDefaultBranch } from './history-compaction';
import { b64encode, deriveRegistryMacKey } from './remote-unlock-crypto';
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

/** The pending rotation, on the remote: the new salt and a verifier of the new key
 *  (what the snapshot itself carries once the rotation commits — nothing secret). */
export const ROTATION_MARKER_FILE = 'gtd25-key-rotation.json';
interface RotationPin { newSalt: string; newVerifier: string; startedAt: number }

function parsePin(json: string): RotationPin | null {
  try {
    const v = JSON.parse(json) as Partial<RotationPin>;
    return typeof v.newSalt === 'string' && typeof v.newVerifier === 'string'
      ? { newSalt: v.newSalt, newVerifier: v.newVerifier, startedAt: Number(v.startedAt) || 0 }
      : null;
  } catch {
    return null;
  }
}
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
  // The remote mark too, or the next change (here or elsewhere) would resume it.
  try {
    const local = await db.localSettings.get('local');
    const pat = await getSyncPat();
    if (pat && local?.githubRepo) {
      const marker = await getFile(pat, local.githubRepo, ROTATION_MARKER_FILE);
      if (marker) await deleteFile(pat, local.githubRepo, ROTATION_MARKER_FILE, marker.sha);
    }
  } catch (err) {
    recordError('keyRotation.discardMarker', err);
  }
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
  // 2. The new key: pinned now, or the pin of an unfinished rotation — this
  //    device's, or the one the remote mark carries (started on another device).
  const marker = await getFile(creds.pat, creds.repo, ROTATION_MARKER_FILE);
  const remotePin = marker ? parsePin(marker.data) : null;
  const localPin = (await db.syncMeta.get('sync-meta'))?.keyRotation ?? null;
  const pin = remotePin ?? localPin;
  const newSalt = pin?.newSalt ?? generateSalt();
  const newKey = await deriveKey(newPassword, newSalt);
  if (pin) {
    if (!(await checkVerifier(newKey, pin.newVerifier))) {
      throw new Error(remotePin && remotePin.newSalt !== localPin?.newSalt
        ? 'A password change started on another device did not finish. Enter the same new password chosen there to complete it, or forget that change first (shared files it already re-encrypted would stay unreadable).'
        : 'A previous password change did not finish. Enter the same new password you chose then to complete it, or discard that change first.');
    }
    if (localPin?.newSalt !== pin.newSalt) await db.syncMeta.update('sync-meta', { keyRotation: pin });
  } else {
    await db.syncMeta.update('sync-meta', {
      keyRotation: { newSalt, newVerifier: await createVerifier(newKey), startedAt: Date.now() },
    });
  }
  if (!remotePin) {
    const pinned = (await db.syncMeta.get('sync-meta'))!.keyRotation!;
    // Created only if absent: two devices starting at once — one of them stops here.
    await putFile(creds.pat, creds.repo, ROTATION_MARKER_FILE, JSON.stringify(pinned), marker?.sha);
  }

  // 3. The Shared Folder's files.
  onProgress({ phase: 'files' });
  const blobs = await withBlobBranchLock(() => rotateBlobBranch(creds, oldKey, newKey, onProgress));

  // 4. The commit point: from here on this device speaks the new key.
  onProgress({ phase: 'snapshot' });
  cacheEncryptionKey(newKey, newSalt);
  await rememberSyncPassword(newPassword);
  let encrypted: SyncData | null = null;
  try {
    encrypted = await forcePush({ backupExisting: false, rekeyChangelogFrom: oldKey });
    // A push can fail AFTER its snapshot landed (the changelog step, or a reply
    // lost on the way back): then the remote is on the new key already.
    if (!encrypted) encrypted = await committedSnapshot(creds, newKey, newSalt);
    if (encrypted) await rekeyRemoteChangelog(creds.pat, creds.repo, oldKey, newKey);
  } finally {
    if (!encrypted) {
      // The snapshot was not written: back to the old key, so this device stays in
      // step with the remote (and with the other devices) instead of asking for a
      // password the repo does not know yet.
      cacheEncryptionKey(oldKey, oldSalt);
      if (oldPassword) await rememberSyncPassword(oldPassword);
      else await forgetSyncPassword();
    }
  }
  if (!encrypted) {
    throw new Error(blobs.blobsRewritten > 0
      ? 'The shared files were already re-encrypted under the new password, but the rest could not be written. Until you finish — change the password again, with the same new password — shared files can\'t be opened on any device.'
      : 'The snapshot could not be rewritten under the new password. Try again with the same new password.');
  }

  // 5. What else still carries the old key. A leftover that could not be
  //    deleted keeps the pin, so the retry deletes it (it used to be logged and
  //    the change reported done, the old password still opening it at the tip).
  onProgress({ phase: 'backups' });
  let leftovers = await deleteMigrationBackups(creds);
  leftovers += await deleteLegacyBlobCopies(creds);
  await rekeyAllBackups(creds.pat, creds.repo, oldKey, newKey, newSalt, encrypted);
  onProgress({ phase: 'registry' });
  if (oldPassword) {
    // Every device's entry and every tombstone, not just this device's: a
    // forgotten (maybe stolen) device's tombstone stopped counting otherwise.
    await remacRegistry(creds.pat, creds.repo, await deriveRegistryMacKey(oldPassword, oldSalt), await deriveRegistryMacKey(newPassword, newSalt));
  }
  await publishOwnRegistryEntry(); // MAC under the new key; false when this device has none to publish
  if (leftovers > 0) throw new Error(`The password was changed, but ${leftovers} old copy(s) could not be deleted. Change the password again with the same new password to finish.`);
  const finishedMarker = await getFile(creds.pat, creds.repo, ROTATION_MARKER_FILE);
  if (finishedMarker) await deleteFile(creds.pat, creds.repo, ROTATION_MARKER_FILE, finishedMarker.sha);
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

/** The remote snapshot, if it already carries the new key (the push failed after it landed). */
async function committedSnapshot(creds: Creds, newKey: CryptoKey, newSalt: string): Promise<SyncData | null> {
  try {
    const file = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE);
    if (!file) return null;
    const snapshot = JSON.parse(file.data) as SyncData;
    if (snapshot.encryptionSalt !== newSalt || !snapshot.encryptionVerifier) return null;
    return (await checkVerifier(newKey, snapshot.encryptionVerifier)) ? snapshot : null;
  } catch (err) {
    recordError('keyRotation.committedSnapshot', err);
    return null;
  }
}

/** The migration backups force pushes write are copies of old snapshots under old
 *  keys. Returns how many could not be deleted. */
async function deleteMigrationBackups(creds: Creds): Promise<number> {
  let failed = 0;
  for (let v = 0; v <= SYNC_VERSION; v++) {
    const path = `gtd25-snapshot-v${v}.backup.json`;
    try {
      const sha = await getFileSha(creds.pat, creds.repo, path);
      if (sha) await deleteFile(creds.pat, creds.repo, path, sha);
    } catch (err) {
      failed++;
      recordError('keyRotation.migrationBackup', err);
    }
  }
  return failed;
}

/** Shared files written before blobs had their own branch, still on the default
 *  branch under the old key. Step 3 copies them over; a delete that failed there
 *  is retried here on every run. Returns how many could not be deleted. */
async function deleteLegacyBlobCopies(creds: Creds): Promise<number> {
  const { pat, repo } = creds;
  let failed = 0;
  try {
    const head = await getRef(pat, repo, await getDefaultBranch(pat, repo));
    if (!head) return 0;
    const { treeSha } = await getCommit(pat, repo, head);
    const { entries } = await getTree(pat, repo, treeSha, true);
    for (const entry of entries) {
      if (entry.type !== 'blob' || !entry.path.startsWith(blobPath('')) || !entry.sha) continue;
      try {
        await deleteFile(pat, repo, entry.path, entry.sha);
      } catch (err) {
        failed++;
        recordError('keyRotation.legacyBlob', err);
      }
    }
  } catch (err) {
    failed++;
    recordError('keyRotation.legacyBlobList', err);
  }
  return failed;
}

function remoteSyncVersion(snapshotJson: string): number | undefined {
  try {
    const version = (JSON.parse(snapshotJson) as SyncData).syncVersion;
    return typeof version === 'number' ? version : undefined;
  } catch {
    return undefined; // unreadable: the snapshot push below has its own handling
  }
}

async function opensWith(key: CryptoKey, bytes: Uint8Array, blobId: string): Promise<Uint8Array | null> {
  try {
    return await decryptSharedBlob(key, bytes, blobId);
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
  const liveIds = readableLiveBlobIds(items);
  if (!liveIds) {
    throw new Error("Some shared items can't be read on this device, so their files can't be carried over. Sync, then try again. Nothing was changed.");
  }
  const dead = new Set(items.filter((i) => i.deletedAt && i.blobId).map((i) => i.blobId!));
  const sizeOf = new Map(items.filter((i) => i.blobId).map((i) => [i.blobId!, i.size]));

  let head = await getRef(pat, repo, BLOB_BRANCH);
  if (!head) {
    if (liveIds.size === 0) return result; // no branch, no files: nothing carries the old key
    await ensureBlobBranch(creds);
    head = await getRef(pat, repo, BLOB_BRANCH);
    if (!head) throw new Error('Could not create the shared-files branch');
  }
  const { treeSha, parents } = await getCommit(pat, repo, head);
  const { entries, truncated } = await getTree(pat, repo, treeSha, true);
  if (truncated) throw new Error('Too many shared files to re-encrypt in one go');
  const onBranch = new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e] as const));
  // Carried over: the live files, and any file on the branch not known deleted
  // here — another device's upload whose item has not reached this device yet.
  const live = [...new Set([
    ...liveIds,
    ...[...onBranch.keys()]
      .filter((path) => path.startsWith(blobPath('')) && path !== KEEP_PATH)
      .map((path) => path.slice(blobPath('').length))
      .filter((blobId) => !dead.has(blobId)),
  ])];

  const keep = onBranch.get(KEEP_PATH);
  const tree: GitTreeEntry[] = [
    keep ?? { path: KEEP_PATH, mode: '100644', type: 'blob', sha: await createBlobBase64(pat, repo, KEEP_CONTENT_BASE64) },
  ];
  const legacyOnDefault: string[] = [];
  for (const [index, blobId] of live.entries()) {
    onProgress({ phase: 'files', done: index, total: live.length });
    const path = blobPath(blobId);
    const existing = onBranch.get(path);
    const budget = sharedBlobDownloadTimeoutMs(sizeOf.get(blobId));
    const bytes = existing
      ? await getBinaryFile(pat, repo, path, undefined, BLOB_BRANCH, budget)
      : await getBinaryFile(pat, repo, path, undefined, undefined, budget); // written before blobs had their own branch
    if (!bytes) continue; // not on the remote: nothing to carry over
    if (!existing) legacyOnDefault.push(path);
    const asIs = async (): Promise<GitTreeEntry> =>
      existing ?? { path, mode: '100644', type: 'blob', sha: await createBlobBase64(pat, repo, b64encode(bytes)) };
    // Already rotated (a retry) — and padded: a file an older version rotated
    // without padding is re-sealed (only a padded file is exactly this long).
    const underNewKey = await opensWith(newKey, bytes, blobId);
    if (underNewKey && bytes.length === paddedLength(underNewKey.length) + 28) {
      tree.push(await asIs());
      continue;
    }
    const plain = underNewKey ?? await opensWith(oldKey, bytes, blobId);
    if (!plain) {
      result.blobsUnreadable++;
      tree.push(await asIs());
      continue;
    }
    const sha = await createBlobBase64(pat, repo, b64encode(await sealSharedBlob(newKey, plain, blobId)));
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
  // A newer version of the app may have moved the repository on meanwhile. Its
  // devices would never get this key — the snapshot push below is refused over
  // a newer version — so moving the files now would strand them under it.
  const snapshot = await getFile(pat, repo, SNAPSHOT_FILE);
  if (snapshot && !isCompatibleVersion(remoteSyncVersion(snapshot.data))) {
    throw new Error('The repository was updated by a newer version of the app. Update this device, then change the password. Nothing was changed.');
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
