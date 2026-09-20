import { db } from './index';
import { ARCHIVED_LIST_RETENTION_MS } from '../lib/constants';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hard-delete soft-deleted items older than 30 days from local IndexedDB.
 * Runs at startup and when the trash modal is opened.
 */
export async function purgeOldTrashItems() {
  const cutoff = Date.now() - THIRTY_DAYS;

  // Shared items first: collect blobIds to remove from the backend + local cache
  // before the metadata rows are hard-deleted. Done outside the entity transaction
  // because deleting a backend blob is a network call.
  const oldShared = await db.sharedItems.filter((i) => !!i.deletedAt && i.deletedAt < cutoff).toArray();
  if (oldShared.length > 0) {
    const { deleteSharedBlob } = await import('../sync/shared-blobs');
    for (const item of oldShared) {
      if (item.blobId) await deleteSharedBlob(item.blobId);
    }
    await db.sharedItems.bulkDelete(oldShared.map((i) => i.id));
  }

  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.mindmapFolders, db.mindmaps, db.mindmapNodes], async () => {
    const oldLists = await db.taskLists.filter((l) => !!l.deletedAt && l.deletedAt < cutoff).toArray();
    for (const l of oldLists) await db.taskLists.delete(l.id);

    const oldTasks = await db.tasks.filter((t) => !!t.deletedAt && t.deletedAt < cutoff).toArray();
    for (const t of oldTasks) await db.tasks.delete(t.id);

    const oldSubs = await db.subtasks.filter((s) => !!s.deletedAt && s.deletedAt < cutoff).toArray();
    for (const s of oldSubs) await db.subtasks.delete(s.id);

    const oldFolders = await db.mindmapFolders.filter((f) => !!f.deletedAt && f.deletedAt < cutoff).toArray();
    for (const f of oldFolders) await db.mindmapFolders.delete(f.id);

    const oldMaps = await db.mindmaps.filter((m) => !!m.deletedAt && m.deletedAt < cutoff).toArray();
    for (const m of oldMaps) await db.mindmaps.delete(m.id);

    const oldNodes = await db.mindmapNodes.filter((n) => !!n.deletedAt && n.deletedAt < cutoff).toArray();
    for (const n of oldNodes) await db.mindmapNodes.delete(n.id);
  });

  // Drop device-local collapse state for maps that no longer exist.
  try {
    const liveMapIds = new Set((await db.mindmaps.toArray()).map((m) => m.id));
    const { useMindmapUi } = await import('../stores/mindmap-ui');
    useMindmapUi.getState().pruneMaps(liveMapIds);
  } catch { /* store unavailable (e.g. bare node env) — cosmetic cleanup only */ }
}

/**
 * Soft-delete lists archived longer than ARCHIVED_LIST_RETENTION_MS (12 months).
 * They land in the Trash like a manual delete — cascading to their tasks and
 * subtasks, recorded in the changelog so the deletion syncs — and the 30-day
 * purge above finishes the job. Runs at startup, from ensureDefaults().
 *
 * deleteTaskList is imported lazily: it lives in the hooks layer, which imports
 * this module's own db (same reason the shared-blob import above is dynamic).
 */
export async function expireArchivedLists(now: number = Date.now()) {
  const cutoff = now - ARCHIVED_LIST_RETENTION_MS;
  const expired = await db.taskLists
    .filter((l) => !l.deletedAt && !!l.archivedAt && l.archivedAt < cutoff)
    .toArray();
  if (expired.length === 0) return;

  const { deleteTaskList } = await import('../hooks/use-task-lists');
  for (const list of expired) {
    await deleteTaskList(list.id);
  }
}
