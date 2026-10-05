import { db } from './index';
import { isParanoidFlagSet } from './paranoid-flag';
import { getActiveAtRestKey } from './vault-middleware';
import { encryptBlob, decryptBlob } from '../sync/crypto';
import { recordError } from '../lib/diagnostics';
import type { ImportData } from './export-import';

// Device-local safety copies: the last line of defence against the app's OWN
// destructive paths (adopt-remote, restore, import), not against disk loss —
// that is what the remote backups are for.
//
// Taken at boot and immediately before anything that replaces local state, so a
// wrong button stays recoverable. On a Paranoid device the copy is encrypted
// with the same at-rest key as the database rows: the old behaviour was to skip
// the backup entirely, which honoured "no plaintext on disk" but left the one
// configuration that most needs a safety net without any.

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

interface StoredBackup extends Partial<BackupPayload> {
  timestamp: number;
  reason?: BackupReason;
  /** Paranoid devices: AES-GCM ciphertext of the JSON payload, and nothing else. */
  encrypted?: string;
}

function listBackupKeys(): string[] {
  // The Storage index API rather than Object.keys, which only happens to list the
  // stored keys in browsers (not in every Storage implementation, e.g. the tests').
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(BACKUP_KEY_PREFIX)) keys.push(key);
  }
  return keys.sort().reverse();
}

function reasonOf(key: string): BackupReason {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? '') as StoredBackup).reason ?? 'boot';
  } catch {
    return 'boot';
  }
}

// Keep the MAX_BACKUPS newest copies, plus the newest one taken before a change
// if app starts have pushed it out of those (at most one extra copy).
// A burst of replacements (repeated remote resets: whoever can write the repo can
// trigger them) used to push the copy taken before the first one out of the ring
// within minutes. The oldest pre-change copy of the last day is kept as well.
const PRE_CHANGE_HOLD_MS = 24 * 60 * 60 * 1000;

function pruneOldBackups() {
  const keys = listBackupKeys();
  const keep = new Set(keys.slice(0, MAX_BACKUPS));
  const changes = keys.filter((key) => reasonOf(key) === 'change');
  const newestBeforeChange = changes[0];
  if (newestBeforeChange) keep.add(newestBeforeChange);
  const since = Date.now() - PRE_CHANGE_HOLD_MS;
  const oldestRecentChange = changes.filter((key) => parseInt(key.replace(BACKUP_KEY_PREFIX, ''), 10) >= since).pop();
  if (oldestRecentChange) keep.add(oldestRecentChange);
  for (const key of keys) {
    if (!keep.has(key)) localStorage.removeItem(key);
  }
}

// Whether the newest stored copy already holds exactly this payload (then an app
// start has nothing new to save). Decrypts on a Paranoid device rather than
// keeping a content fingerprint, which would let a guess be confirmed.
async function newestCopyHolds(payload: BackupPayload, key: CryptoKey | null): Promise<boolean> {
  const newest = listBackupKeys()[0];
  if (!newest) return false;
  try {
    const stored = JSON.parse(localStorage.getItem(newest) ?? '') as StoredBackup;
    const body: Partial<BackupPayload> = stored.encrypted
      ? (key ? JSON.parse(await decryptBlob(key, stored.encrypted)) : {})
      : stored;
    const pick = (b: Partial<BackupPayload>) => JSON.stringify([
      b.taskLists, b.tasks, b.subtasks, b.mindmapFolders, b.mindmaps, b.mindmapNodes,
    ]);
    return pick(body) === pick(payload);
  } catch {
    return false;
  }
}

/** Delete every safety backup on this device (Paranoid enable, secondary unlock). */
export function purgeLocalBackups(): void {
  try {
    for (const key of listBackupKeys()) localStorage.removeItem(key);
  } catch { /* storage unavailable: nothing we could remove */ }
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
  for (const storageKey of listBackupKeys()) {
    let stored: StoredBackup;
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) ?? '') as StoredBackup;
    } catch {
      continue; // not JSON: readLocalBackup already reports it as corrupted
    }
    if (!stored.encrypted) continue;
    try {
      const payload = JSON.parse(await decryptBlob(key, stored.encrypted)) as BackupPayload;
      // The reason too: dropped, a held pre-change copy became prunable.
      localStorage.setItem(storageKey, JSON.stringify({ timestamp: stored.timestamp, reason: stored.reason, ...payload }));
    } catch (err) {
      recordError('backup.decryptOnDisable', err);
      localStorage.removeItem(storageKey);
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
  return { taskLists, tasks, subtasks, mindmapFolders, mindmaps, mindmapNodes };
}

/**
 * Store the copy, making room if localStorage is full; false if it could not be
 * stored. Room is made oldest first, and an app-start copy never pushes out a
 * copy taken before a change: the full-storage fallback used to drop EVERY other
 * copy — the pre-import one PRE_CHANGE_HOLD_MS exists for included — and, if the
 * new copy still did not fit, left the device with none.
 */
function writeWithRoom(key: string, serialized: string, reason: BackupReason): boolean {
  const tryWrite = () => {
    try {
      localStorage.setItem(key, serialized);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryWrite()) {
    const older = listBackupKeys().filter((k) => k !== key).reverse(); // oldest first
    // The oldest pre-change copy of the last day is never evicted: in a burst of
    // replacements (repeated remote resets) it holds the data from before the
    // first one — exactly what PRE_CHANGE_HOLD_MS keeps it for.
    const since = Date.now() - PRE_CHANGE_HOLD_MS;
    const held = older.find((k) => reasonOf(k) === 'change' && parseInt(k.replace(BACKUP_KEY_PREFIX, ''), 10) >= since);
    const evictable = [
      ...older.filter((k) => reasonOf(k) === 'boot'),
      // A copy taken before a change may make room only for a newer such copy.
      ...(reason === 'change' ? older.filter((k) => reasonOf(k) === 'change' && k !== held) : []),
    ];
    let stored = false;
    for (const victim of evictable) {
      localStorage.removeItem(victim);
      if ((stored = tryWrite())) break;
    }
    if (!stored) {
      recordError('backup.localStorageFull', new Error(`No room for a ${reason} safety copy`));
      return false;
    }
  }
  pruneOldBackups();
  return true;
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
    const backup: StoredBackup = key
      ? { timestamp, reason, encrypted: await encryptBlob(key, JSON.stringify(payload)) }
      : { timestamp, reason, ...payload };

    return writeWithRoom(`${BACKUP_KEY_PREFIX}${timestamp}`, JSON.stringify(backup), reason);
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

export function getLocalBackups(): Array<{ key: string; timestamp: number }> {
  return listBackupKeys().map((key) => ({
    key,
    timestamp: parseInt(key.replace(BACKUP_KEY_PREFIX, ''), 10),
  }));
}

/**
 * Read + validate a safety backup, decrypting it on a Paranoid device. Returns
 * ImportData for the sync engine's importData() — restoring must go through it
 * (NOT direct table writes) so FK validation, change entries, and sync
 * propagation apply. Throws a descriptive error on a corrupt or malformed backup.
 */
export async function readLocalBackup(key: string): Promise<ImportData> {
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error('Backup not found');

  let stored: StoredBackup;
  try {
    stored = JSON.parse(raw) as StoredBackup;
  } catch {
    throw new Error('Backup is corrupted (not valid JSON)');
  }

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
  return {
    taskLists: body.taskLists,
    tasks: body.tasks,
    subtasks: body.subtasks,
    ...(Array.isArray(body.mindmaps) ? {
      mindmapFolders: body.mindmapFolders ?? [],
      mindmaps: body.mindmaps,
      mindmapNodes: body.mindmapNodes ?? [],
    } : {}),
  };
}
