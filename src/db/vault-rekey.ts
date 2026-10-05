// Re-key: mint a fresh DEK and rewrite everything this device holds under it,
// so a key that was ever copied out of here — an old disk image plus the
// passphrase of that time, a security key since removed, a trusted device since
// revoked, a memory dump — opens nothing written from now on. It does not
// un-copy anything: whoever holds an old copy and its key keeps that copy.
//
// Same shape as the secondary-passphrase re-init (vault-reinit.ts), minus the
// severing of sync: all crypto in memory first, then ONE transaction swaps the
// content tables, the changelog, the shared-blob cache and the vault row.
// Interrupted ⇒ rolled back, and the old key still opens everything.

import { db } from './index';
import type { Vault, ChangeEntry } from './models';
import type { KdfParams } from './vault-kdf';
import type { VaultSecrets } from './vault';
import { generateDek, wrapDek, generateGarbageSlot } from './vault-crypto';
import { createVerifier, encryptBlob, generateSalt } from '../sync/crypto';
import { encryptRow, type Row } from './vault-middleware';
import { CONTENT_TABLES, readContentRows, encryptContentRows } from './vault-content';

export interface RekeyResult {
  /** Security keys that were enrolled: their wraps opened the old DEK, so they are gone. */
  securityKeysDropped: number;
  /**
   * Remote unlock after the re-key: 'none' (it was not enrolled), 'rotated' (a new
   * remote-unlock key handed to the approvers — the old one opens nothing written
   * from now on) or 'turned-off' (that could not be done; set it up again).
   */
  remoteUnlock: 'none' | 'rotated' | 'turned-off';
}

export interface RekeyInput {
  vault: Vault;
  /** KEK of the passphrase that will open slot 1, derived at `newSalt` with `kdf`. */
  newKek: CryptoKey;
  newSalt: string;
  kdf: KdfParams;
  secrets: VaultSecrets | null;
}

/**
 * Rewrite this device under a fresh DEK. The caller has re-authenticated, holds
 * the old DEK as the active middleware key (every read below decrypts with it),
 * and has told the other tabs to lock. Returns the new DEK once it is on disk;
 * the caller installs it.
 */
export async function rekeyVaultContent(input: RekeyInput): Promise<{ newDek: CryptoKey; result: RekeyResult }> {
  // 1. Everything, decrypted under the old key. A row the old key cannot read
  //    (quarantined by the middleware) would come out as a placeholder for good;
  //    this is a deliberate operation, not an emergency, so it refuses instead.
  const plainByTable = await readContentRows();
  const unreadable = [...plainByTable.values()].flat().filter((r) => r._decryptError === true).length;
  if (unreadable > 0) {
    throw new Error(`${unreadable} item(s) on this device can't be read with the current key. Run Verify integrity and re-sync them from another device before re-keying.`);
  }
  const changeLog = (await db.changeLog.toArray()) as unknown as Row[];
  if (changeLog.some((e) => (e.data as Row | undefined)?._enc !== undefined)) {
    throw new Error('changeLog read without the vault key');
  }

  // 2. A fresh DEK; every row pre-encrypted under it, in memory.
  const newDek = await generateDek();
  const encByTable = await encryptContentRows(newDek, plainByTable);
  const encChangeLog = await Promise.all(changeLog.map((e) => encryptRow('changeLog', newDek, e) as Promise<Row>));
  // Open sync conflicts hold both versions of an edit: carried over under the new
  // key (a quarantined one holds nothing to carry).
  const conflicts = ((await db.syncConflicts.toArray()) as unknown as Row[]).filter((c) => !c._decryptError);
  const encConflicts = await Promise.all(conflicts.map((c) => encryptRow('syncConflicts', newDek, c) as Promise<Row>));

  // 3. The re-keyed vault row: slot 1 under the given KEK, slot 2 fresh garbage
  //    (the secondary passphrase's KEK is not at hand, so it has to be set again),
  //    security keys dropped for the same reason (each needs a touch to re-wrap),
  //    and the remote-unlock key dropped too: the approvers hold a copy of it, and
  //    whoever had the old DEK could read it from any old image — re-wrapping the
  //    new DEK under it made the re-key worthless to such a person. The approver
  //    list stays (sealed under the new DEK) so the caller can hand out a new key.
  const { vault, newKek, newSalt, kdf, secrets } = input;
  const securityKeysDropped = vault.securityKeys?.length
    ?? (vault.webauthnCredentialId && vault.dekWrappedByPrf ? 1 : 0);
  const enrolled = !!(vault.dekWrappedByRuk || vault.dekWrappedByRukNext);
  const remote: Pick<Vault, 'remoteUnlock'> = enrolled && vault.remoteUnlock
    ? {
        remoteUnlock: {
          approvers: vault.remoteUnlock.approvers,
          seal: await encryptBlob(newDek, JSON.stringify(vault.remoteUnlock.approvers)),
        },
      }
    : {};
  const newVault: Vault = {
    id: 'vault',
    dekWrappedByPass: await wrapDek(newKek, newDek, 'slot1'),
    wrappedDek2: await generateGarbageSlot(),
    passSalt: newSalt,
    kdf,
    prfSalt: generateSalt(),
    verifier: await createVerifier(newDek),
    secrets: await encryptBlob(newDek, JSON.stringify(secrets ?? {})),
    idleTimeoutMinutes: vault.idleTimeoutMinutes,
    maxUnlockAttempts: vault.maxUnlockAttempts,
    failedUnlockAttempts: 0,
    migrationState: 'done',
    ...remote,
  };

  // 4. One transaction. The rows already carry `_enc`, so the middleware passes
  //    them through whatever key it holds: no crypto runs inside the transaction
  //    (Safari), and nothing reads raw ciphertext through a bypass window.
  const tables = CONTENT_TABLES.map((t) => t.table());
  await db.transaction('rw', [...tables, db.changeLog, db.sharedBlobs, db.vault, db.syncConflicts], async () => {
    for (const t of CONTENT_TABLES) {
      await t.table().clear();
      const enc = encByTable.get(t.name) ?? [];
      if (enc.length) await t.table().bulkPut(enc as unknown[]);
    }
    await db.changeLog.clear();
    if (encChangeLog.length) await db.changeLog.bulkPut(encChangeLog as unknown as ChangeEntry[]);
    await db.sharedBlobs.clear(); // a mirror of the backend: re-downloaded under the new key
    await db.syncConflicts.clear();
    if (encConflicts.length) await db.syncConflicts.bulkPut(encConflicts as never[]);
    await db.vault.put(newVault);
  });

  return { newDek, result: { securityKeysDropped, remoteUnlock: enrolled ? 'turned-off' : 'none' } };
}
