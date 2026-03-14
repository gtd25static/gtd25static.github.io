import type { SyncData } from '../db/models';

export function cleanupSoftDeletes(data: SyncData, maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): SyncData {
  const cutoff = Date.now() - maxAgeMs;
  return {
    ...data,
    taskLists: data.taskLists.filter((l) => !l.deletedAt || l.deletedAt > cutoff),
    tasks: data.tasks.filter((t) => !t.deletedAt || t.deletedAt > cutoff),
    subtasks: data.subtasks.filter((s) => !s.deletedAt || s.deletedAt > cutoff),
    soundPresets: data.soundPresets?.filter((p) => !p.deletedAt || p.deletedAt > cutoff),
  };
}

const ARCHIVE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Auto-archive completed tasks older than 90 days during compaction.
 * Archived tasks are excluded from search, motivation stats, and default list views.
 */
export function archiveOldCompleted(data: SyncData): SyncData {
  const cutoff = Date.now() - ARCHIVE_AGE_MS;
  return {
    ...data,
    tasks: data.tasks.map((t) => {
      if (t.status === 'done' && !t.archived) {
        const completedAt = t.completedAt ?? t.updatedAt;
        if (completedAt < cutoff) {
          return { ...t, archived: true, updatedAt: Date.now() };
        }
      }
      return t;
    }),
  };
}
