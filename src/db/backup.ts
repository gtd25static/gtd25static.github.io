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

interface StoredBackup extends Partial<BackupPayload> {
  timestamp: number;
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

function pruneOldBackups() {
  for (const key of listBackupKeys().slice(MAX_BACKUPS)) {
    localStorage.removeItem(key);
  }
}

/** Delete every safety backup on this device (Paranoid enable, secondary unlock). */
export function purgeLocalBackups(): void {
  try {
    for (const key of listBackupKeys()) localStorage.removeItem(key);
  } catch { /* storage unavailable: nothing we could remove */ }
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
 * Store the copy, making room if localStorage is full. A failure here used to be
 * a `console.warn` nobody reads — leaving the user believing they had a safety
 * net that was never written.
 */
function writeWithRoom(key: string, serialized: string): void {
  try {
    localStorage.setItem(key, serialized);
  } catch (err) {
    // Full: drop every older copy and try once more keeping only this one.
    for (const existing of listBackupKeys()) {
      if (existing !== key) localStorage.removeItem(existing);
    }
    try {
      localStorage.setItem(key, serialized);
    } catch {
      recordError('backup.localStorageFull', err);
      return;
    }
  }
  pruneOldBackups();
}

export async function createLocalBackup(): Promise<void> {
  try {
    const key = getActiveAtRestKey();
    // Paranoid + locked: rows come back still encrypted, so this would store
    // double-wrapped nonsense. Nothing to report — the boot-time call simply
    // runs before unlock, and every destructive path is behind the lock anyway.
    if (isParanoidFlagSet() && !key) return;

    const payload = await readPayload();
    const isEmpty = payload.taskLists.length === 0 && payload.tasks.length === 0 &&
      payload.subtasks.length === 0 && (payload.mindmaps?.length ?? 0) === 0;
    if (isEmpty) return;

    const timestamp = Date.now();
    const backup: StoredBackup = key
      ? { timestamp, encrypted: await encryptBlob(key, JSON.stringify(payload)) }
      : { timestamp, ...payload };

    writeWithRoom(`${BACKUP_KEY_PREFIX}${timestamp}`, JSON.stringify(backup));
  } catch (err) {
    // A backup failure must never block the operation it was protecting.
    recordError('backup.create', err);
  }
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
    if (!atRestKey) throw new Error('Unlock the vault to restore this backup');
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
