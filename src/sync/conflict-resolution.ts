import type { SyncData } from '../db/models';

export function cleanupSoftDeletes(data: SyncData, maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): SyncData {
  const cutoff = Date.now() - maxAgeMs;
  return {
    ...data,
    taskLists: data.taskLists.filter((l) => !l.deletedAt || l.deletedAt > cutoff),
    tasks: data.tasks.filter((t) => !t.deletedAt || t.deletedAt > cutoff),
    subtasks: data.subtasks.filter((s) => !s.deletedAt || s.deletedAt > cutoff),
  };
}
