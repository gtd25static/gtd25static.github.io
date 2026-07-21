import { db } from '../db';
import type { ChangeEntry } from '../db/models';
import { newId } from '../lib/id';
import { SYNC_VERSION } from './version';
import { migrateEntryData } from './migrations';
import { mergeEntity, stampUpdatedFields } from './field-timestamps';
import { prepareEntityRowsForAtRest } from './at-rest-writes';
import type { Subtask, Task, TaskList, SharedItem, MindmapFolder, Mindmap, MindmapNode } from '../db/models';

type EntityRow = TaskList | Task | Subtask | SharedItem | MindmapFolder | Mindmap | MindmapNode;

async function getDeviceId(): Promise<string> {
  const local = await db.localSettings.get('local');
  return local?.deviceId ?? 'unknown';
}

export async function recordChange(
  entityType: ChangeEntry['entityType'],
  entityId: string,
  operation: ChangeEntry['operation'],
  data?: Record<string, unknown>,
) {
  const deviceId = await getDeviceId();
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

function validateEntityShape(data: Record<string, unknown> | undefined, entityType: ChangeEntry['entityType']): boolean {
  if (!data || typeof data !== 'object') return false;
  const fields = requiredFields[entityType];
  for (const field of fields) {
    if (!(field in data) || data[field] == null) return false;
  }
  return true;
}

export async function applyRemoteEntries(entries: ChangeEntry[]) {
  // Sort by timestamp ascending so later entries win
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
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
        const localUpdatedAt = existing.updatedAt ?? 0;
        if (entry.timestamp >= localUpdatedAt) {
          const updated = {
            ...existing,
            deletedAt: entry.timestamp,
            updatedAt: entry.timestamp,
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
        setChanged(entry.entityType, entry.entityId, merged as unknown as EntityRow);
      }
    } else {
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
    && mindmapFolders.length === 0 && mindmaps.length === 0 && mindmapNodes.length === 0) return;

  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.sharedItems, db.mindmapFolders, db.mindmaps, db.mindmapNodes], async () => {
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
  });
}

export async function getPendingEntries(limit?: number): Promise<ChangeEntry[]> {
  const query = db.changeLog.orderBy('timestamp');
  return limit != null ? query.limit(limit).toArray() : query.toArray();
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

  const count = await db.changeLog.count();
  if (count <= MAX_CHANGELOG_ENTRIES_OFFLINE) return 0;

  const toRemove = count - PRUNE_TARGET;
  const oldest = await db.changeLog.orderBy('timestamp').limit(toRemove).toArray();
  await db.changeLog.bulkDelete(oldest.map((e) => e.id));
  // Track that pruning occurred so we can warn when sync is later enabled
  await db.localSettings.update('local', { changelogPruned: true });
  return oldest.length;
}
