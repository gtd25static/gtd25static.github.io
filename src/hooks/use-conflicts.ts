import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { ChangeEntry, DiscussionEntry, SyncConflict } from '../db/models';
import { conflictTable, conflictSuperseded, type ConflictEntityType } from '../sync/conflicts';
import { withSyncLock } from '../sync/sync-lock';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH } from '../lib/constants';
import { stampUpdatedFields } from '../sync/field-timestamps';
import { ensureDeviceId } from '../sync/change-log';
import { SYNC_VERSION } from '../sync/version';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { encryptRow, getActiveAtRestKey, type Row } from '../db/vault-middleware';
import { handleDbError } from '../lib/db-error';
import { newId } from '../lib/id';

const TABLE_NAME: Record<ConflictEntityType, string> = {
  task: 'tasks', subtask: 'subtasks', taskList: 'taskLists',
  mindmapFolder: 'mindmapFolders', mindmap: 'mindmaps', mindmapNode: 'mindmapNodes',
};

/**
 * The open sync conflicts, oldest first — without the ones that no longer stand
 * (edited again since, item gone, too old): a stale card used to stay until the
 * next successful sync, and picking a version on it overwrote the newer edit.
 */
export function useConflicts(): SyncConflict[] {
  return useLiveQuery(async () => {
    const open = (await db.syncConflicts.orderBy('detectedAt').toArray())
      .filter((c) => !(c as { _decryptError?: boolean })._decryptError);
    const current: SyncConflict[] = [];
    for (const c of open) {
      if (!conflictSuperseded(c, await conflictTable(c.entityType).get(c.entityId))) current.push(c);
    }
    return current;
  }, [], []) ?? [];
}

/** A text the user wrote or picked, made to fit the field as any edit would; null if it cannot. */
function fitValue(field: string, value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  if (field === 'title' || field === 'name' || field === 'label') {
    const text = value.trim().slice(0, MAX_TITLE_LENGTH);
    return text ? text : null; // these may not be empty
  }
  return value;
}

/** Bring back a deleted item the way the Trash does: with its parents, and what was deleted with it. */
async function restoreItem(entityType: ConflictEntityType, id: string, row: Record<string, unknown>): Promise<void> {
  switch (entityType) {
    case 'task': return (await import('./use-tasks')).restoreTask(id);
    case 'subtask': return (await import('./use-subtasks')).restoreSubtask(id);
    case 'taskList': return (await import('./use-task-lists')).restoreTaskList(id);
    case 'mindmap': return (await import('./use-mindmaps')).restoreMindmap(id);
    case 'mindmapFolder': return (await import('./use-mindmaps')).restoreMindmapFolder(id);
    case 'mindmapNode': {
      const mindmaps = await import('./use-mindmaps');
      const map = await db.mindmaps.get(String(row.mapId));
      if (map?.deletedAt) await mindmaps.restoreMindmap(map.id);
      return mindmaps.restoreMindmapNodeSubtree([id]);
    }
  }
}

/** What the user picked: one side's version, a version they wrote, or — for a delete — restore or not. */
export type ConflictChoice = { keep: 'local' | 'remote' } | { value: unknown } | { restore: boolean };

/**
 * Apply the user's choice as a new edit of the field, stamped now: it reaches
 * every device as an ordinary change and closes the conflict there too (a later
 * edit supersedes it — sync/conflicts.ts conflictSuperseded). Writing it even
 * when the choice is the version already shown is the point: the other device
 * may show the other one. Pre-encrypted outside the transaction (Paranoid Mode,
 * Safari — see updateTask).
 */
export async function resolveConflict(conflict: SyncConflict, choice: ConflictChoice): Promise<void> {
  // Under the sync lock: a sync merge landing between the read and the write
  // below would be overwritten here.
  await withSyncLock(() => resolveConflictLocked(conflict, choice));
}

async function resolveConflictLocked(conflict: SyncConflict, choice: ConflictChoice): Promise<void> {
  try {
    const table = conflictTable(conflict.entityType);
    const row = await table.get(conflict.entityId);
    const sameSpot = (await db.syncConflicts.where('entityId').equals(conflict.entityId).toArray())
      .filter((c) => c.field === conflict.field)
      .map((c) => c.id);
    if (!row) {
      await db.syncConflicts.bulkDelete(sameSpot);
      return;
    }

    const now = Date.now();
    let changes: Record<string, unknown>;
    if (conflict.kind === 'field') {
      const picked = 'value' in choice
        ? choice.value
        : 'keep' in choice ? (choice.keep === 'local' ? conflict.localValue : conflict.remoteValue) : undefined;
      if (conflict.field.startsWith('discussionLog:')) {
        const entryId = conflict.field.slice('discussionLog:'.length);
        const log = (row.discussionLog ?? []) as DiscussionEntry[];
        const note = typeof picked === 'string' && picked.trim() ? picked : undefined;
        // editedAt closes the conflict on the other device (sync/conflicts.ts).
        changes = { discussionLog: log.map((e) => (e.id === entryId ? { ...e, note, editedAt: now } : e)) };
      } else {
        const value = fitValue(conflict.field, picked);
        if (value === null) {
          toast('That can’t be empty — pick a version or write one.', 'error');
          return;
        }
        changes = { [conflict.field]: value };
      }
    } else if ('restore' in choice && choice.restore) {
      await restoreItem(conflict.entityType, conflict.entityId, row);
      await db.syncConflicts.bulkDelete(sameSpot);
      return;
    } else {
      changes = { deletedAt: row.deletedAt ?? now };
    }

    const updated: Record<string, unknown> = {
      ...row,
      ...changes,
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(row.fieldTimestamps as Record<string, number> | undefined, Object.keys(changes), now),
    };
    for (const [field, value] of Object.entries(changes)) if (value === undefined) delete updated[field];
    const change: ChangeEntry = {
      id: newId(), deviceId: await ensureDeviceId(), timestamp: now,
      entityType: conflict.entityType, entityId: conflict.entityId, operation: 'upsert', data: updated, v: SYNC_VERSION,
    };

    let rowOut: Row = updated;
    let changeOut: Row = change as unknown as Row;
    const key = getActiveAtRestKey();
    if (key) {
      const [encRow, encChange] = await Promise.all([
        encryptRow(TABLE_NAME[conflict.entityType], key, rowOut),
        encryptRow('changeLog', key, changeOut),
      ]);
      if (!encRow || !encChange) throw new Error('Failed to encrypt the resolved conflict');
      rowOut = encRow;
      changeOut = encChange;
    }
    await db.transaction('rw', [table, db.changeLog, db.syncConflicts], async () => {
      await table.put(rowOut);
      await db.changeLog.add(changeOut as unknown as ChangeEntry);
      await db.syncConflicts.bulkDelete(sameSpot);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'resolve the conflict');
  }
}
