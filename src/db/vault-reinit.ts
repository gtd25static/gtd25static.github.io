import { db } from './index';
import type { Vault } from './models';
import { generateDek, wrapDek, generateGarbageSlot } from './vault-crypto';
import { createVerifier, encryptBlob } from '../sync/crypto';
import { CONTENT_TABLES, readContentRows, encryptContentRows } from './vault-content';
import { placeholderRow, placeholderBlobBytes } from '../lib/placeholder-content';
import { purgeLocalBackups } from './backup';
import { SHARE_CACHE } from '../lib/share-target';
import { clearErrorLog } from '../lib/diagnostics';
import { closeAllNotifications } from '../lib/notifications';
import { newId } from '../lib/id';
import { DEFAULT_MAX_ATTEMPTS } from '../lib/constants';

// Duress unlock: entering the duress passphrase looks like a normal unlock but
// atomically replaces ALL real content with decoy lorem (structure preserved)
// and re-keys the vault so the duress passphrase becomes the real one going
// forward. See THREAT_MODEL "Coerced unlock (duress)".
//
// Reliability & no-trace guarantees (the user's hard requirement):
//  - All crypto runs IN MEMORY first; a SINGLE rw transaction then swaps
//    everything. Interrupted mid-way ⇒ the transaction rolls back and the device
//    is byte-for-byte in its pre-duress state (real data intact, retryable) —
//    never a half-exposed state.
//  - Every content table is CLEARED and rewritten from the decoy set, so no
//    stale real-content row can survive.
//  - Everything wrapping or encrypted under the OLD DEK is destroyed: slot 1/2,
//    verifier, secrets, PRF security keys, the remote-unlock wrap, the changelog
//    (old `_enc` snapshots), sync bookkeeping and the shared-blob cache.
//  - Sync credentials are dropped, so the decoy can't be pushed over the real
//    data on the backend and the adversary gets no live sync to lean on — and so
//    is what ties this device to the real repo (repo name, device id, the
//    remote-unlock identity) and what only a synced device would have.
//  - What lives OUTSIDE IndexedDB is destroyed right after the commit: the
//    device-local safety backups (encrypted under the old DEK — unreadable, but
//    listed with their dates in Settings and failing to restore, which would
//    expose the swap), a share stashed while locked (PLAINTEXT, and offered by
//    the share prompt on the next unlocked start), the diagnostics log (sync
//    activity, remote file names), sync bookkeeping in localStorage, and the
//    app's notifications (nudges quote real task titles). None of it can join the
//    Dexie transaction; a tab killed in between leaves it behind on an already
//    re-keyed device — never a half-swapped vault.
//
// Residual (documented, not hidden): IndexedDB does not securely erase
// overwritten pages, so a forensic image taken AFTER this runs may still contain
// old ciphertext in free space — but that ciphertext is only readable with the
// real DEK, which no longer exists anywhere on the device. Duress defends the
// "unlock it now" coercion, not a before/after forensic diff.

// localStorage keys that only exist once sync has run on this device (owned by
// sync-engine and remote-backups; pinned by the reliability test).
const SYNC_HISTORY_KEYS = [
  'gtd25-legacy-checked',
  'gtd25-sync-dirty',
  'gtd25-backup-hourly-at',
  'gtd25-backup-daily-at',
  'gtd25-backup-weekly-at',
];

/**
 * Re-key the vault to decoy content. `realDek` was just unwrapped from slot 2;
 * `duressKek` is the KEK derived from the duress passphrase during that unlock
 * (reused so the duress passphrase unlocks normally afterwards). Returns the
 * fresh DEK the caller installs as the live key.
 *
 * The caller MUST have the real DEK active as the middleware key while this
 * reads (so the content decrypts), and MUST install the returned DEK afterwards.
 */
export async function reinitVaultWithPlaceholders(vault: Vault, realDek: CryptoKey, duressKek: CryptoKey): Promise<CryptoKey> {
  // 1. Read + decrypt every content row (real DEK is the active middleware key);
  //    readContentRows refuses a row still carrying `_enc` (read WITHOUT the key),
  //    whose decoy would land in the new vault unreadable.
  const plainByTable = await readContentRows();
  const blobs = await db.sharedBlobs.toArray();

  // 2. Build decoy rows and pre-encrypt them under a FRESH DEK, in memory. A
  //    quarantined row (`_decryptError`) has real content that is already
  //    unreadable, so it gets a decoy like any other, minus the corruption flag.
  const newDek = await generateDek();
  const encByTable = await encryptContentRows(
    newDek, plainByTable, (entityType, { _decryptError: _corrupt, ...row }) => placeholderRow(entityType, row),
  );
  // Shared-blob cache: keep the ids/structure, replace bytes with dummy text.
  const placeholderBlobs = blobs.map((b) => ({ ...b, data: placeholderBlobBytes(b.id) }));

  // 3. Build the re-keyed vault row (slot 1 = new DEK under the duress KEK; slot
  //    2 fresh garbage; verifier/secrets under the new DEK; every real-DEK
  //    wrap and PRF/remote enrolment dropped).
  const newVault: Vault = {
    id: 'vault',
    dekWrappedByPass: await wrapDek(duressKek, newDek, 'slot1'),
    wrappedDek2: await generateGarbageSlot(),
    passSalt: vault.passSalt,
    kdf: vault.kdf,
    prfSalt: vault.prfSalt,
    verifier: await createVerifier(newDek),
    secrets: await encryptBlob(newDek, JSON.stringify({})),
    idleTimeoutMinutes: vault.idleTimeoutMinutes,
    // Default rather than undefined: a decoy vault that inherits "never
    // configured" gets armed on its next unlock, and the one-time "this vault
    // predates the setting" banner would appear right after a duress unlock.
    maxUnlockAttempts: vault.maxUnlockAttempts ?? DEFAULT_MAX_ATTEMPTS,
    failedUnlockAttempts: 0,
    migrationState: 'done',
    // securityKeys / dekWrappedByPrf / dekWrappedByRuk / remoteUnlock all omitted:
    // they wrap the OLD DEK, so they must not survive (a stale key would fail to
    // decrypt the decoy and expose the swap).
  };

  // 4. One atomic transaction: swap content, vault, and sever sync. A crash here
  //    rolls the whole thing back to the pre-duress state.
  const tables = CONTENT_TABLES.map((t) => t.table());
  await db.transaction(
    'rw',
    [...tables, db.vault, db.changeLog, db.syncMeta, db.sharedBlobs, db.localSettings],
    async () => {
      for (const t of CONTENT_TABLES) {
        await t.table().clear();
        const enc = encByTable.get(t.name) ?? [];
        if (enc.length) await t.table().bulkPut(enc as unknown[]);
      }
      await db.sharedBlobs.clear();
      if (placeholderBlobs.length) await db.sharedBlobs.bulkPut(placeholderBlobs);
      await db.changeLog.clear();     // old `_enc` snapshots under the real DEK
      await db.syncMeta.clear();      // remote SHAs / pull cursors of the real repo
      await db.vault.put(newVault);
      // Cover story: sync was never set up here. Drop any plaintext creds too, and
      // what ties this device to the real repo: its name, the device id every real
      // change was stamped with, the remote-unlock identity published in the repo's
      // device registry. The unlock log keeps only passphrase entries — a security
      // key or remote unlock can't have happened on a vault that has neither.
      const local = await db.localSettings.get('local');
      await db.localSettings.update('local', {
        githubPat: undefined,
        encryptionPassword: undefined,
        githubRepo: undefined,
        syncEnabled: false,
        changelogPruned: undefined,
        remoteApproverFor: undefined,
        deviceId: newId(),
        deviceIdentity: undefined,
        unlockLog: local?.unlockLog?.filter((e) => e.method === 'passphrase'),
      });
    },
  );

  // 5. Outside IndexedDB (see the header) — only once the swap has committed.
  purgeLocalBackups();
  for (const key of SYNC_HISTORY_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  clearErrorLog();
  try {
    if (typeof caches !== 'undefined') await caches.delete(SHARE_CACHE);
  } catch { /* no Cache Storage in this context: nothing was stashed */ }
  await closeAllNotifications();

  void realDek; // consumed only as the read key before this call; not persisted
  return newDek;
}
