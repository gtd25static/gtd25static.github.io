import { db } from './index';
import { isParanoidFlagSet } from './paranoid-flag';
import { getActiveAtRestKey } from './vault-middleware';
import { encryptBlob, decryptBlob } from '../sync/crypto';
import { recordError } from '../lib/diagnostics';
import type { ImportData } from './export-import';
import type { LocalBackup } from './models';
import { portableRows } from './portable-rows';

// Device-local safety copies: the last line of defence against the app's OWN
// destructive paths (adopt-remote, restore, import), not against disk loss —
// that is what the remote backups are for.
//
// Taken at boot and immediately before anything that replaces local state, so a
// wrong button stays recoverable. On a Paranoid device the copy is encrypted
// with the same at-rest key as the database rows: the old behaviour was to skip
// the backup entirely, which honoured "no plaintext on disk" but left the one
// configuration that most needs a safety net without any.

// Where they live: IndexedDB (table localBackups) since 2026-10-06. In
// localStorage — a few MB shared with every other key — two copies stopped
// fitting at ~1,200 tasks and one at ~2,000; each start then evicted the copies
// that did fit and failed anyway. Copies an older build left there are moved
// over at startup (adoptLegacyLocalBackups). Ids keep the old key format.
const BACKUP_KEY_PREFIX = 'gtd25-local-backup-';
const MAX_BACKUPS = 2;

/**
 * What we snapshot. Shared-folder items are excluded on purpose: their bytes
 * live in a separate blob store and ImportData has no field to restore them
 * through, so copying the metadata alone would promise a recovery we can't make.
 */
type BackupPayload = Pick<ImportData, 'taskLists' | 'tasks' | 'subtasks' | 'mindmapFolders' | 'mindmaps' | 'mindmapNodes'>;

/**
 * Why a copy was taken: at app start, or right before something replaced local
 * data. Only two copies are kept and every start takes one, so without telling
 * them apart two restarts pushed out the copy taken before an import / restore /
 * pull — the one a mistake would need. Older copies have no reason (read: boot).
 */
export type BackupReason = 'boot' | 'change';

type StoredBackup = LocalBackup;

/** Every copy, newest first. */
async function listBackups(): Promise<StoredBackup[]> {
  return (await db.localBackups.toArray()).sort((a, b) => b.timestamp - a.timestamp);
}

// Keep the MAX_BACKUPS newest copies, plus the newest one taken before a change
// if app starts have pushed it out of those (at most one extra copy).
// A burst of replacements (repeated remote resets: whoever can write the repo can
// trigger them) used to push the copy taken before the first one out of the ring
// within minutes. The oldest pre-change copy of the last day is kept as well.
const PRE_CHANGE_HOLD_MS = 24 * 60 * 60 * 1000;

async function pruneOldBackups(): Promise<void> {
  const copies = await listBackups();
  const keep = new Set(copies.slice(0, MAX_BACKUPS).map((c) => c.id));
  const changes = copies.filter((c) => (c.reason ?? 'boot') === 'change');
  if (changes[0]) keep.add(changes[0].id);
  const since = Date.now() - PRE_CHANGE_HOLD_MS;
  const oldestRecentChange = changes.filter((c) => c.timestamp >= since).pop();
  if (oldestRecentChange) keep.add(oldestRecentChange.id);
  await db.localBackups.bulkDelete(copies.filter((c) => !keep.has(c.id)).map((c) => c.id));
}

// Whether the newest stored copy already holds exactly this payload (then an app
// start has nothing new to save). Decrypts on a Paranoid device rather than
// keeping a content fingerprint, which would let a guess be confirmed.
async function newestCopyHolds(payload: BackupPayload, key: CryptoKey | null): Promise<boolean> {
  const [newest] = await listBackups();
  if (!newest) return false;
  try {
    const body: Partial<BackupPayload> = newest.encrypted
      ? (key ? JSON.parse(await decryptBlob(key, newest.encrypted)) : {})
      : newest;
    const pick = (b: Partial<BackupPayload>) => JSON.stringify([
      b.taskLists, b.tasks, b.subtasks, b.mindmapFolders, b.mindmaps, b.mindmapNodes,
    ]);
    return pick(body) === pick(payload);
  } catch {
    return false;
  }
}

function legacyBackupKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(BACKUP_KEY_PREFIX)) keys.push(key);
    }
  } catch { /* storage unavailable */ }
  return keys;
}

/**
 * Move the copies an older build kept in localStorage into IndexedDB (startup,
 * from ensureDefaults). One that is not readable JSON is dropped.
 */
export async function adoptLegacyLocalBackups(): Promise<void> {
  for (const key of legacyBackupKeys()) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? '') as Omit<StoredBackup, 'id'>;
      const timestamp = Number(stored.timestamp) || parseInt(key.slice(BACKUP_KEY_PREFIX.length), 10) || 0;
      await db.localBackups.put({ ...stored, id: key, timestamp });
    } catch (err) {
      recordError('backup.adoptLegacy', err);
    }
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
}

/** Delete every safety backup on this device (Paranoid enable, secondary unlock, re-key). */
export async function purgeLocalBackups(): Promise<void> {
  try {
    await db.localBackups.clear();
  } catch (err) {
    recordError('backup.purge', err);
  }
  for (const key of legacyBackupKeys()) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
}

/**
 * Paranoid disable: rewrite this device's encrypted safety backups as plaintext
 * while the at-rest key still exists. The disable destroys the key, which used to
 * leave backups listed in Settings that could never be opened again. One that
 * fails to decrypt is dropped rather than kept as a dead entry.
 */
export async function decryptLocalBackups(): Promise<void> {
  const key = getActiveAtRestKey();
  if (!key) return;
  for (const stored of await listBackups()) {
    if (!stored.encrypted) continue;
    try {
      const payload = JSON.parse(await decryptBlob(key, stored.encrypted)) as BackupPayload;
      // The reason too: dropped, a held pre-change copy became prunable.
      await db.localBackups.put({ id: stored.id, timestamp: stored.timestamp, reason: stored.reason, ...payload });
    } catch (err) {
      recordError('backup.decryptOnDisable', err);
      await db.localBackups.delete(stored.id);
    }
  }
}

async function readPayload(): Promise<BackupPayload> {
  const [taskLists, tasks, subtasks, mindmapFolders, mindmaps, mindmapNodes] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.toArray(),
    db.subtasks.toArray(),
    db.mindmapFolders.toArray(),
    db.mindmaps.toArray(),
    db.mindmapNodes.toArray(),
  ]);
  // Never a placeholder for a row this device can't read, nor its sync bookkeeping (portableRows).
  return {
    taskLists: portableRows(taskLists).rows, tasks: portableRows(tasks).rows, subtasks: portableRows(subtasks).rows,
    mindmapFolders: portableRows(mindmapFolders).rows, mindmaps: portableRows(mindmaps).rows,
    mindmapNodes: portableRows(mindmapNodes).rows,
  };
}

/**
 * Take a safety copy. Returns false when one was due but could not be stored —
 * the destructive caller then says so (it used to go ahead in silence); true
 * when it was stored or there was nothing to copy.
 */
export async function createLocalBackup({ reason = 'change' }: { reason?: BackupReason } = {}): Promise<boolean> {
  try {
    const key = getActiveAtRestKey();
    // Paranoid + locked: rows come back still encrypted, so this would store
    // double-wrapped nonsense. Nothing to report — the boot-time call simply
    // runs before unlock, and every destructive path is behind the lock anyway.
    if (isParanoidFlagSet() && !key) return true;

    const payload = await readPayload();
    const isEmpty = payload.taskLists.length === 0 && payload.tasks.length === 0 &&
      payload.subtasks.length === 0 && (payload.mindmaps?.length ?? 0) === 0;
    if (isEmpty) return true;
    if (reason === 'boot' && await newestCopyHolds(payload, key)) return true;

    const timestamp = Date.now();
    const id = `${BACKUP_KEY_PREFIX}${timestamp}`;
    const backup: StoredBackup = key
      ? { id, timestamp, reason, encrypted: await encryptBlob(key, JSON.stringify(payload)) }
      : { id, timestamp, reason, ...payload };

    await db.localBackups.put(backup);
    await pruneOldBackups();
    return true;
  } catch (err) {
    // A backup failure must never block the operation it was protecting.
    recordError('backup.create', err);
    return false;
  }
}

/** For the destructive operations: take the pre-change copy, and say so if it failed. */
export async function createLocalBackupOrWarn(): Promise<void> {
  if (await createLocalBackup()) return;
  const { toast } = await import('../components/ui/Toast');
  toast("Couldn't save a safety copy on this device first (storage full?) — going ahead without one.", 'error');
}

/** The copies, newest first (a read only: usable in a live query). */
export async function getLocalBackups(): Promise<Array<{ key: string; timestamp: number; reason: BackupReason }>> {
  return (await listBackups()).map((c) => ({ key: c.id, timestamp: c.timestamp, reason: c.reason ?? 'boot' }));
}

/**
 * Read + validate a safety backup, decrypting it on a Paranoid device. Returns
 * ImportData for the sync engine's importData() — restoring must go through it
 * (NOT direct table writes) so FK validation, change entries, and sync
 * propagation apply. Throws a descriptive error on a corrupt or malformed backup.
 */
export async function readLocalBackup(key: string): Promise<ImportData> {
  const stored = await db.localBackups.get(key);
  if (!stored) throw new Error('Backup not found');

  let body: Partial<BackupPayload> = stored;
  if (stored.encrypted) {
    const atRestKey = getActiveAtRestKey();
    if (!atRestKey) {
      throw new Error(isParanoidFlagSet()
        ? 'Unlock the vault to restore this backup'
        : 'This backup was encrypted by Paranoid Mode, which has since been turned off, so it can no longer be opened');
    }
    try {
      body = JSON.parse(await decryptBlob(atRestKey, stored.encrypted)) as Partial<BackupPayload>;
    } catch {
      throw new Error('Backup could not be decrypted (wrong key or corrupted)');
    }
  }

  if (!Array.isArray(body.taskLists) || !Array.isArray(body.tasks) || !Array.isArray(body.subtasks)) {
    throw new Error('Backup structure is invalid');
  }
  // Mindmap fields are absent in pre-2026-07-27 backups; leaving them undefined
  // is what tells importData to preserve this device's maps rather than wipe them.
  // Placeholders an older build copied in are left out (portableRows).
  return {
    taskLists: portableRows(body.taskLists).rows,
    tasks: portableRows(body.tasks).rows,
    subtasks: portableRows(body.subtasks).rows,
    ...(Array.isArray(body.mindmaps) ? {
      mindmapFolders: portableRows(body.mindmapFolders ?? []).rows,
      mindmaps: portableRows(body.mindmaps).rows,
      mindmapNodes: portableRows(body.mindmapNodes ?? []).rows,
    } : {}),
  };
}
