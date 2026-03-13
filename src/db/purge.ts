import { db } from './index';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hard-delete soft-deleted items older than 30 days from local IndexedDB.
 * Runs at startup and when the trash modal is opened.
 */
export async function purgeOldTrashItems() {
  const cutoff = Date.now() - THIRTY_DAYS;
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
    const oldLists = await db.taskLists.filter((l) => !!l.deletedAt && l.deletedAt < cutoff).toArray();
    for (const l of oldLists) await db.taskLists.delete(l.id);

    const oldTasks = await db.tasks.filter((t) => !!t.deletedAt && t.deletedAt < cutoff).toArray();
    for (const t of oldTasks) await db.tasks.delete(t.id);

    const oldSubs = await db.subtasks.filter((s) => !!s.deletedAt && s.deletedAt < cutoff).toArray();
    for (const s of oldSubs) await db.subtasks.delete(s.id);
  });
}
