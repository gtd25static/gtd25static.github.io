import { db } from '../db';
import type { ChangeEntry } from '../db/models';
import { newId } from '../lib/id';
import { SYNC_VERSION } from './version';
import { migrateEntryData } from './migrations';
import { mergeEntity, stampUpdatedFields, capFutureTimestamps, MAX_FUTURE_SKEW_MS } from './field-timestamps';
import { noteRemoteDeletions } from '../db/purge';
import { prepareEntityRowsForAtRest } from './at-rest-writes';
import type { Subtask, Task, TaskList, SharedItem, MindmapFolder, Mindmap, MindmapNode } from '../db/models';

type EntityRow = TaskList | Task | Subtask | SharedItem | MindmapFolder | Mindmap | MindmapNode;

async function getDeviceId(): Promise<string> {
  const local = await db.localSettings.get('local');
  return local?.deviceId ?? 'unknown';
}

// Cached deviceId to avoid reading db.localSettings inside transactions
let cachedDeviceId: string | null = null;

export async function ensureDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  cachedDeviceId = await getDeviceId();
  return cachedDeviceId;
}

export function clearDeviceIdCache() {
  cachedDeviceId = null;
}

/**
 * Record a change within an existing Dexie transaction.
 * The caller must include db.changeLog in the transaction scope.
 * Uses cached deviceId to avoid accessing db.localSettings within the transaction.
 */
export async function recordChangeInTx(
  entityType: ChangeEntry['entityType'],
  entityId: string,
  operation: ChangeEntry['operation'],
  data?: Record<string, unknown>,
) {
  const deviceId = cachedDeviceId ?? await getDeviceId();
  await db.changeLog.add({
    id: newId(),
    deviceId,
    timestamp: Date.now(),
    entityType,
    entityId,
    operation,
    data,
    v: SYNC_VERSION,
  });
}

export async function recordChangeBatch(
  entries: Array<{
    entityType: ChangeEntry['entityType'];
    entityId: string;
    operation: ChangeEntry['operation'];
    data?: Record<string, unknown>;
  }>,
) {
  if (entries.length === 0) return;
  const deviceId = await getDeviceId();
  const now = Date.now();
  const records: ChangeEntry[] = entries.map((e) => ({
    id: newId(),
    deviceId,
    timestamp: now,
    entityType: e.entityType,
    entityId: e.entityId,
    operation: e.operation,
    data: e.data,
    v: SYNC_VERSION,
  }));
  await db.changeLog.bulkAdd(records);
}

/**
 * Record a batch of changes within an existing Dexie transaction.
 * The caller must include db.changeLog in the transaction scope.
 * Uses cached deviceId to avoid accessing db.localSettings within the transaction.
 */
export async function recordChangeBatchInTx(
  entries: Array<{
    entityType: ChangeEntry['entityType'];
    entityId: string;
    operation: ChangeEntry['operation'];
    data?: Record<string, unknown>;
  }>,
) {
  if (entries.length === 0) return;
  const deviceId = cachedDeviceId ?? await getDeviceId();
  const now = Date.now();
  const records: ChangeEntry[] = entries.map((e) => ({
    id: newId(),
    deviceId,
    timestamp: now,
    entityType: e.entityType,
    entityId: e.entityId,
    operation: e.operation,
    data: e.data,
    v: SYNC_VERSION,
  }));
  await db.changeLog.bulkAdd(records);
}

const tableForEntity = {
  taskList: () => db.taskLists,
  task: () => db.tasks,
  subtask: () => db.subtasks,
  sharedItem: () => db.sharedItems,
  mindmapFolder: () => db.mindmapFolders,
  mindmap: () => db.mindmaps,
  mindmapNode: () => db.mindmapNodes,
} as const;

const tableNameForEntity = {
  taskList: 'taskLists',
  task: 'tasks',
  subtask: 'subtasks',
  sharedItem: 'sharedItems',
  mindmapFolder: 'mindmapFolders',
  mindmap: 'mindmaps',
  mindmapNode: 'mindmapNodes',
} as const;

const requiredFields: Record<ChangeEntry['entityType'], string[]> = {
  taskList: ['id', 'name', 'order', 'createdAt', 'updatedAt'],
  task: ['id', 'listId', 'title', 'status', 'order', 'createdAt', 'updatedAt'],
  subtask: ['id', 'taskId', 'title', 'status', 'order', 'createdAt', 'updatedAt'],
  sharedItem: ['id', 'type', 'name', 'size', 'order', 'createdAt', 'updatedAt'],
  mindmapFolder: ['id', 'name', 'order', 'createdAt', 'updatedAt'],
  mindmap: ['id', 'name', 'order', 'createdAt', 'updatedAt'],
  // parentId is deliberately NOT required: the root node has none.
  mindmapNode: ['id', 'mapId', 'label', 'order', 'createdAt', 'updatedAt'],
};

/** One of the entity kinds this app syncs (not just any string a remote entry names). */
export function isKnownEntityType(entityType: unknown): entityType is ChangeEntry['entityType'] {
  return typeof entityType === 'string' && Object.hasOwn(requiredFields, entityType);
}

function validateEntityShape(data: Record<string, unknown> | undefined, entityType: ChangeEntry['entityType']): boolean {
  if (!data || typeof data !== 'object') return false;
  const fields = requiredFields[entityType];
  for (const field of fields) {
    if (!(field in data) || data[field] == null) return false;
  }
  return true;
}

// How many times a merge is recomputed when local edits keep landing under it.
const MAX_APPLY_ATTEMPTS = 3;

/**
 * Pending-entry ids recorded since `before` was taken. Every local edit records
 * its entry in the same transaction as its row, so a new id means a row may have
 * changed after the merge read it. Keys only: nothing is decrypted, so this is
 * safe inside a write transaction (Safari, Paranoid Mode).
 */
export async function pendingIdsAddedSince(before: Set<string>): Promise<boolean> {
  const now = (await db.changeLog.toCollection().primaryKeys()) as string[];
  return now.some((id) => !before.has(id));
}

/**
 * Merge remote entries into the local rows. The merge reads the rows, computes,
 * pre-encrypts (Paranoid) and only then writes — a local edit committed in that
 * window used to be overwritten by the merge of the row as it was before it (the
 * edit reverted on this device while its pending entry still reached the
 * others). Such a write is now abandoned and the merge recomputed from fresh
 * rows. Returns false if edits kept landing and nothing was written; the next
 * sync re-applies the entries (they are re-read from the remote each time).
 */
export async function applyRemoteEntries(entries: ChangeEntry[]): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt++) {
    if (await applyRemoteEntriesOnce(entries)) return true;
  }
  return false;
}

async function applyRemoteEntriesOnce(entries: ChangeEntry[]): Promise<boolean> {
  const pendingBefore = new Set(await getPendingIds());
  // Sort by timestamp ascending so later entries win
  // Remote entries are written by whoever can write the repository. An unknown
  // kind is skipped (a forged `entityType` used to throw and stop every sync on
  // every device), and timestamps beyond the skew tolerance are capped — a change
  // stamped 9e15 used to beat every later edit, delete or restore, for good.
  const now = Date.now();
  const sorted = entries
    .filter((e) => isKnownEntityType(e.entityType) && Number.isFinite(e.timestamp))
    .map((e) => ({
      ...e,
      timestamp: Math.min(e.timestamp, now + MAX_FUTURE_SKEW_MS),
      data: e.data ? capFutureTimestamps(e.data, now) : e.data,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  // Records this sync moves into the Trash: their 30 days run from now, here.
  const newlyDeleted: string[] = [];
  const localState: Record<ChangeEntry['entityType'], Map<string, EntityRow | null>> = {
    taskList: new Map<string, EntityRow | null>(),
    task: new Map<string, EntityRow | null>(),
    subtask: new Map<string, EntityRow | null>(),
    sharedItem: new Map<string, EntityRow | null>(),
    mindmapFolder: new Map<string, EntityRow | null>(),
    mindmap: new Map<string, EntityRow | null>(),
    mindmapNode: new Map<string, EntityRow | null>(),
  };
  const writes: Record<ChangeEntry['entityType'], Map<string, EntityRow>> = {
    taskList: new Map<string, EntityRow>(),
    task: new Map<string, EntityRow>(),
    subtask: new Map<string, EntityRow>(),
    sharedItem: new Map<string, EntityRow>(),
    mindmapFolder: new Map<string, EntityRow>(),
    mindmap: new Map<string, EntityRow>(),
    mindmapNode: new Map<string, EntityRow>(),
  };

  async function getCurrent(entityType: ChangeEntry['entityType'], entityId: string): Promise<EntityRow | null> {
    const cache = localState[entityType];
    if (cache.has(entityId)) return cache.get(entityId) ?? null;
    const existing = await tableForEntity[entityType]().get(entityId) ?? null;
    cache.set(entityId, existing as EntityRow | null);
    return existing as EntityRow | null;
  }

  function setChanged(entityType: ChangeEntry['entityType'], entityId: string, row: EntityRow): void {
    localState[entityType].set(entityId, row);
    writes[entityType].set(entityId, row);
  }

  for (const entry of sorted) {
    if (entry.operation === 'delete') {
      const existing = await getCurrent(entry.entityType, entry.entityId);
      if (existing) {
        // A delete is a change to one field, deletedAt, and loses only to a newer
        // change of that same field (a restore). Weighing it against the whole
        // row's updatedAt let an edit of another field made just after the delete
        // keep the row alive here, while the field merge on the deleting device
        // and compaction kept the tombstone — the devices then disagreed. Rows
        // without field timestamps (pre-v5 data) keep the row-level rule.
        const localFT = (existing as unknown as Record<string, unknown>).fieldTimestamps as Record<string, number> | undefined;
        const newerLocal = localFT ? localFT.deletedAt ?? 0 : existing.updatedAt ?? 0;
        if (entry.timestamp >= newerLocal) {
          if (!existing.deletedAt) newlyDeleted.push(entry.entityId);
          const updated = {
            ...existing,
            deletedAt: entry.timestamp,
            updatedAt: Math.max(existing.updatedAt ?? 0, entry.timestamp),
            fieldTimestamps: stampUpdatedFields(
              (existing as unknown as Record<string, unknown>).fieldTimestamps as Record<string, number> | undefined,
              ['deletedAt'],
              entry.timestamp,
            ),
          };
          setChanged(entry.entityType, entry.entityId, updated as EntityRow);
        }
      }
      continue;
    }

    // Migrate entry data from older format versions
    const data = entry.data ? migrateEntryData(entry.data, entry.entityType, entry.v) : entry.data;

    // Validate entity shape before writing
    if (!validateEntityShape(data, entry.entityType)) {
      console.warn(`Skipping malformed ${entry.entityType} entry ${entry.id}: missing required fields`);
      continue;
    }

    // upsert with field-level merge
    const existing = await getCurrent(entry.entityType, entry.entityId);
    if (existing) {
      const merged = mergeEntity(
        existing as unknown as Record<string, unknown>,
        data as Record<string, unknown>,
        entry.timestamp,
      );
      if (merged) {
        if (merged.deletedAt && !existing.deletedAt) newlyDeleted.push(entry.entityId);
        setChanged(entry.entityType, entry.entityId, merged as unknown as EntityRow);
      }
    } else {
      if (data?.deletedAt) newlyDeleted.push(entry.entityId);
      setChanged(entry.entityType, entry.entityId, data as unknown as EntityRow);
    }
  }

  const [taskLists, tasks, subtasks, sharedItems, mindmapFolders, mindmaps, mindmapNodes] = await Promise.all([
    prepareEntityRowsForAtRest(tableNameForEntity.taskList, Array.from(writes.taskList.values()) as TaskList[]),
    prepareEntityRowsForAtRest(tableNameForEntity.task, Array.from(writes.task.values()) as Task[]),
    prepareEntityRowsForAtRest(tableNameForEntity.subtask, Array.from(writes.subtask.values()) as Subtask[]),
    prepareEntityRowsForAtRest(tableNameForEntity.sharedItem, Array.from(writes.sharedItem.values()) as SharedItem[]),
    prepareEntityRowsForAtRest(tableNameForEntity.mindmapFolder, Array.from(writes.mindmapFolder.values()) as MindmapFolder[]),
    prepareEntityRowsForAtRest(tableNameForEntity.mindmap, Array.from(writes.mindmap.values()) as Mindmap[]),
    prepareEntityRowsForAtRest(tableNameForEntity.mindmapNode, Array.from(writes.mindmapNode.values()) as MindmapNode[]),
  ]);

  if (taskLists.length === 0 && tasks.length === 0 && subtasks.length === 0 && sharedItems.length === 0
    && mindmapFolders.length === 0 && mindmaps.length === 0 && mindmapNodes.length === 0) return true;

  const written = await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.sharedItems, db.mindmapFolders, db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
    if (await pendingIdsAddedSince(pendingBefore)) return false;
    if (taskLists.length > 0) {
      await db.taskLists.bulkPut(taskLists);
    }
    if (tasks.length > 0) {
      await db.tasks.bulkPut(tasks);
    }
    if (subtasks.length > 0) {
      await db.subtasks.bulkPut(subtasks);
    }
    if (sharedItems.length > 0) {
      await db.sharedItems.bulkPut(sharedItems);
    }
    if (mindmapFolders.length > 0) {
      await db.mindmapFolders.bulkPut(mindmapFolders);
    }
    if (mindmaps.length > 0) {
      await db.mindmaps.bulkPut(mindmaps);
    }
    if (mindmapNodes.length > 0) {
      await db.mindmapNodes.bulkPut(mindmapNodes);
    }
    return true;
  });
  if (!written) return false;
  await noteRemoteDeletions(newlyDeleted);
  return true;
}

export async function getPendingEntries(limit?: number): Promise<ChangeEntry[]> {
  const query = db.changeLog.orderBy('timestamp');
  return limit != null ? query.limit(limit).toArray() : query.toArray();
}

/** Ids of every pending entry (keys only: nothing is decrypted). */
export async function getPendingIds(): Promise<string[]> {
  return (await db.changeLog.toCollection().primaryKeys()) as string[];
}

export async function clearPendingEntries(): Promise<void> {
  await db.changeLog.clear();
}

export async function clearEntriesByIds(ids: string[]): Promise<void> {
  await db.changeLog.bulkDelete(ids);
}

export function pendingEntryCount(): Promise<number> {
  return db.changeLog.count();
}

export function hasPendingEntries(): Promise<boolean> {
  return db.changeLog.count().then((c) => c > 0);
}

const MAX_CHANGELOG_ENTRIES_OFFLINE = 10_000;
const PRUNE_TARGET = 5_000;

/**
 * Cap changelog size when sync is disabled. Without this, the changelog
 * grows unbounded for users who never enable sync.
 */
export async function pruneChangelogIfSyncDisabled(): Promise<number> {
  const local = await db.localSettings.get('local');
  if (local?.syncEnabled) return 0;

  await compactOfflineChangelog();
  const count = await db.changeLog.count();
  if (count <= MAX_CHANGELOG_ENTRIES_OFFLINE) return 0;

  const toRemove = count - PRUNE_TARGET;
  const oldest = await db.changeLog.orderBy('timestamp').limit(toRemove).toArray();
  await db.changeLog.bulkDelete(oldest.map((e) => e.id));
  // Track that pruning occurred so we can warn when sync is later enabled
  await db.localSettings.update('local', { changelogPruned: true });
  return oldest.length;
}

/**
 * With sync off nothing reads the changelog until sync is set up, and then only
 * each record's latest change matters (linking never merges past versions). It
 * used to keep up to 10,000 full past versions of every record — titles, notes,
 * labels, including records deleted for good — for anyone with the unlocked app,
 * or the disk of a device without Paranoid Mode. Keep only the newest entry per
 * record, and none for a record that no longer exists here (purged).
 */
async function compactOfflineChangelog(): Promise<void> {
  const entries = await db.changeLog.orderBy('timestamp').toArray();
  if (entries.length === 0) return;
  const newest = new Map<string, ChangeEntry>();
  for (const e of entries) newest.set(`${e.entityType}:${e.entityId}`, e); // ascending: the last one wins
  const keep = new Set<string>();
  for (const e of newest.values()) {
    if (!isKnownEntityType(e.entityType)) continue;
    if (await tableForEntity[e.entityType]().get(e.entityId)) keep.add(e.id);
  }
  const drop = entries.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (drop.length > 0) await db.changeLog.bulkDelete(drop);
}
