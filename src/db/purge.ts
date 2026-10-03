import { db } from './index';
import { ARCHIVED_LIST_RETENTION_MS, COMPLETED_RETENTION_MS } from '../lib/constants';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/**
 * Note records that sync has just moved into this device's Trash (see
 * LocalSettings.trashArrivals). Their deletedAt is whatever the remote says —
 * a writer to the repository could date it years back, and the purge below
 * used to hard-delete such a record at the very next start, with no Trash at all.
 */
export async function noteRemoteDeletions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await db.transaction('rw', db.localSettings, async () => {
    const local = await db.localSettings.get('local');
    if (!local) return;
    const trashArrivals = { ...(local.trashArrivals ?? {}) };
    for (const id of ids) trashArrivals[id] ??= now;
    await db.localSettings.update('local', { trashArrivals });
  });
}

/**
 * Hard-delete soft-deleted items older than 30 days from local IndexedDB — 30
 * days from their deletedAt and, when sync brought the delete, from its arrival
 * here too. Runs at startup and when the trash modal is opened.
 */
export async function purgeOldTrashItems() {
  const cutoff = Date.now() - THIRTY_DAYS;
  const arrivals = (await db.localSettings.get('local'))?.trashArrivals ?? {};
  const expired = (row: { id: string; deletedAt?: number }) =>
    !!row.deletedAt && row.deletedAt < cutoff && (arrivals[row.id] ?? 0) < cutoff;

  // Shared items first: collect blobIds to remove from the backend + local cache
  // before the metadata rows are hard-deleted. Done outside the entity transaction
  // because deleting a backend blob is a network call.
  const oldShared = await db.sharedItems.filter(expired).toArray();
  if (oldShared.length > 0) {
    const { deleteSharedBlob } = await import('../sync/shared-blobs');
    for (const item of oldShared) {
      if (item.blobId) await deleteSharedBlob(item.blobId);
    }
    await db.sharedItems.bulkDelete(oldShared.map((i) => i.id));
  }

  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.mindmapFolders, db.mindmaps, db.mindmapNodes], async () => {
    const oldLists = await db.taskLists.filter(expired).toArray();
    for (const l of oldLists) await db.taskLists.delete(l.id);

    const oldTasks = await db.tasks.filter(expired).toArray();
    for (const t of oldTasks) await db.tasks.delete(t.id);

    const oldSubs = await db.subtasks.filter(expired).toArray();
    for (const s of oldSubs) await db.subtasks.delete(s.id);

    const oldFolders = await db.mindmapFolders.filter(expired).toArray();
    for (const f of oldFolders) await db.mindmapFolders.delete(f.id);

    const oldMaps = await db.mindmaps.filter(expired).toArray();
    for (const m of oldMaps) await db.mindmaps.delete(m.id);

    const oldNodes = await db.mindmapNodes.filter(expired).toArray();
    for (const n of oldNodes) await db.mindmapNodes.delete(n.id);
  });

  await forgetSettledArrivals(arrivals);

  // Drop device-local collapse state for maps that no longer exist.
  try {
    const liveMapIds = new Set((await db.mindmaps.toArray()).map((m) => m.id));
    const { useMindmapUi } = await import('../stores/mindmap-ui');
    useMindmapUi.getState().pruneMaps(liveMapIds);
  } catch { /* store unavailable (e.g. bare node env) — cosmetic cleanup only */ }
}

/** Drop arrival entries whose record is gone (purged) or no longer in the Trash (restored). */
async function forgetSettledArrivals(arrivals: Record<string, number>): Promise<void> {
  const ids = Object.keys(arrivals);
  if (ids.length === 0) return;
  const tables = [db.taskLists, db.tasks, db.subtasks, db.sharedItems, db.mindmapFolders, db.mindmaps, db.mindmapNodes];
  const stillInTrash = new Set<string>();
  for (const table of tables) {
    for (const row of await (table as unknown as { bulkGet(k: string[]): Promise<Array<{ id: string; deletedAt?: number } | undefined>> }).bulkGet(ids)) {
      if (row?.deletedAt) stillInTrash.add(row.id);
    }
  }
  if (stillInTrash.size === ids.length) return;
  await db.transaction('rw', db.localSettings, async () => {
    const local = await db.localSettings.get('local');
    if (!local?.trashArrivals) return;
    const trashArrivals = Object.fromEntries(Object.entries(local.trashArrivals).filter(([id]) => stillInTrash.has(id) || !(id in arrivals)));
    await db.localSettings.update('local', { trashArrivals });
  });
}

/**
 * gtd25 keeps work, not an archive: tasks completed and follow-ups resolved more
 * than COMPLETED_RETENTION_MS (12 months) ago go to the Trash, with their
 * subtasks, like a delete by hand — recorded in the changelog so every device
 * converges — and the 30-day purge above ends them. Counted from completedAt
 * (a follow-up: from when it was resolved), not the last edit; open items,
 * however old, are never touched. Runs at startup, from ensureDefaults().
 */
export async function expireCompletedItems(now: number = Date.now()) {
  const cutoff = now - COMPLETED_RETENTION_MS;
  const [lists, tasks] = await Promise.all([db.taskLists.toArray(), db.tasks.toArray()]);
  const followUpLists = new Set(lists.filter((l) => l.type === 'follow-ups').map((l) => l.id));
  const expired = tasks.filter((t) => {
    if (t.deletedAt) return false;
    if (followUpLists.has(t.listId)) return !!t.archived && (t.fieldTimestamps?.archived ?? t.updatedAt) < cutoff;
    return t.status === 'done' && (t.completedAt ?? t.updatedAt) < cutoff;
  });
  if (expired.length === 0) return;

  const { deleteTasksBatch } = await import('../hooks/use-bulk-operations');
  await deleteTasksBatch(expired.map((t) => t.id), now);
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
