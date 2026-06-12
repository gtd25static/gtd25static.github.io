import { db } from './index';
import { isParanoidFlagSet } from './paranoid-flag';
import type { ImportData } from './export-import';

const BACKUP_KEY_PREFIX = 'gtd25-local-backup-';
const MAX_BACKUPS = 2;

export async function createLocalBackup(): Promise<void> {
  // Paranoid devices leave no plaintext backup snapshots on disk.
  if (isParanoidFlagSet()) return;
  try {
    const [taskLists, tasks, subtasks] = await Promise.all([
      db.taskLists.toArray(),
      db.tasks.toArray(),
      db.subtasks.toArray(),
    ]);

    // Don't create backup if there's no data
    if (taskLists.length === 0 && tasks.length === 0 && subtasks.length === 0) return;

    const backup = {
      timestamp: Date.now(),
      taskLists,
      tasks,
      subtasks,
    };

    const key = `${BACKUP_KEY_PREFIX}${Date.now()}`;
    localStorage.setItem(key, JSON.stringify(backup));
    pruneOldBackups();
  } catch {
    // localStorage full or other error — non-critical, continue without backup
    console.warn('Failed to create local backup');
  }
}

function pruneOldBackups() {
  const keys = Object.keys(localStorage)
    .filter((k) => k.startsWith(BACKUP_KEY_PREFIX))
    .sort()
    .reverse();

  for (const key of keys.slice(MAX_BACKUPS)) {
    localStorage.removeItem(key);
  }
}

export function getLocalBackups(): Array<{ key: string; timestamp: number }> {
  return Object.keys(localStorage)
    .filter((k) => k.startsWith(BACKUP_KEY_PREFIX))
    .sort()
    .reverse()
    .map((key) => {
      const ts = parseInt(key.replace(BACKUP_KEY_PREFIX, ''), 10);
      return { key, timestamp: ts };
    });
}

/**
 * Read + validate a boot-time safety backup. Returns ImportData for the sync
 * engine's importData() — restoring must go through it (NOT direct table
 * writes) so FK validation, change entries, and sync propagation apply.
 * Throws a descriptive error on a corrupt or malformed backup.
 */
export function readLocalBackup(key: string): ImportData {
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error('Backup not found');

  let backup: unknown;
  try {
    backup = JSON.parse(raw);
  } catch {
    throw new Error('Backup is corrupted (not valid JSON)');
  }
  const b = backup as Partial<ImportData>;
  if (!Array.isArray(b.taskLists) || !Array.isArray(b.tasks) || !Array.isArray(b.subtasks)) {
    throw new Error('Backup structure is invalid');
  }
  return { taskLists: b.taskLists, tasks: b.tasks, subtasks: b.subtasks };
}
