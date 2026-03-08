import { db } from './index';

const BACKUP_KEY_PREFIX = 'gtd25-local-backup-';
const MAX_BACKUPS = 2;

export async function createLocalBackup(): Promise<void> {
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

export async function restoreLocalBackup(key: string): Promise<void> {
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error('Backup not found');

  const backup = JSON.parse(raw);
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
    await db.taskLists.clear();
    await db.tasks.clear();
    await db.subtasks.clear();
    await db.taskLists.bulkPut(backup.taskLists);
    await db.tasks.bulkPut(backup.tasks);
    await db.subtasks.bulkPut(backup.subtasks);
  });
}
