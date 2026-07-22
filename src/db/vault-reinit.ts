import { db } from './index';
import type { Vault } from './models';
import { generateDek, wrapDek, generateGarbageSlot } from './vault-crypto';
import { createVerifier, encryptBlob } from '../sync/crypto';
import { encryptRow, type Row } from './vault-middleware';
import { placeholderRow, placeholderBlobBytes } from '../lib/placeholder-content';

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
//    data on the backend and the adversary gets no live sync to lean on.
//
// Residual (documented, not hidden): IndexedDB does not securely erase
// overwritten pages, so a forensic image taken AFTER this runs may still contain
// old ciphertext in free space — but that ciphertext is only readable with the
// real DEK, which no longer exists anywhere on the device. Duress defends the
// "unlock it now" coercion, not a before/after forensic diff.

const CONTENT_TABLES: Array<{ name: string; entityType: string; table: () => import('dexie').Table<unknown, string> }> = [
  { name: 'taskLists', entityType: 'taskList', table: () => db.taskLists as unknown as import('dexie').Table<unknown, string> },
  { name: 'tasks', entityType: 'task', table: () => db.tasks as unknown as import('dexie').Table<unknown, string> },
  { name: 'subtasks', entityType: 'subtask', table: () => db.subtasks as unknown as import('dexie').Table<unknown, string> },
  { name: 'sharedItems', entityType: 'sharedItem', table: () => db.sharedItems as unknown as import('dexie').Table<unknown, string> },
  { name: 'mindmapFolders', entityType: 'mindmapFolder', table: () => db.mindmapFolders as unknown as import('dexie').Table<unknown, string> },
  { name: 'mindmaps', entityType: 'mindmap', table: () => db.mindmaps as unknown as import('dexie').Table<unknown, string> },
  { name: 'mindmapNodes', entityType: 'mindmapNode', table: () => db.mindmapNodes as unknown as import('dexie').Table<unknown, string> },
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
  // 1. Read + decrypt every content row (real DEK is the active middleware key).
  const plainByTable = new Map<string, Row[]>();
  for (const t of CONTENT_TABLES) {
    plainByTable.set(t.name, (await t.table().toArray()) as Row[]);
  }
  const blobs = await db.sharedBlobs.toArray();

  // 2. Build decoy rows and pre-encrypt them under a FRESH DEK, in memory.
  const newDek = await generateDek();
  const encByTable = new Map<string, Row[]>();
  for (const t of CONTENT_TABLES) {
    const rows = plainByTable.get(t.name) ?? [];
    const enc = await Promise.all(
      rows.map((r) => encryptRow(t.name, newDek, placeholderRow(t.entityType, r)) as Promise<Row>),
    );
    encByTable.set(t.name, enc);
  }
  // Shared-blob cache: keep the ids/structure, replace bytes with dummy text.
  const placeholderBlobs = blobs.map((b) => ({ ...b, data: placeholderBlobBytes(b.id) }));

  // 3. Build the re-keyed vault row (slot 1 = new DEK under the duress KEK; slot
  //    2 fresh garbage; verifier/secrets under the new DEK; every real-DEK
  //    wrap and PRF/remote enrolment dropped).
  const newVault: Vault = {
    id: 'vault',
    dekWrappedByPass: await wrapDek(duressKek, newDek),
    wrappedDek2: await generateGarbageSlot(),
    passSalt: vault.passSalt,
    kdf: vault.kdf,
    prfSalt: vault.prfSalt,
    verifier: await createVerifier(newDek),
    secrets: await encryptBlob(newDek, JSON.stringify({})),
    idleTimeoutMinutes: vault.idleTimeoutMinutes,
    maxUnlockAttempts: vault.maxUnlockAttempts,
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
      // Cover story: sync was never set up here. Drop any plaintext creds too.
      await db.localSettings.update('local', {
        githubPat: undefined,
        encryptionPassword: undefined,
        syncEnabled: false,
        remoteApproverFor: undefined,
      });
    },
  );

  void realDek; // consumed only as the read key before this call; not persisted
  return newDek;
}
