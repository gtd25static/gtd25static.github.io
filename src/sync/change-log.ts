import { db } from '../db';
import type { ChangeEntry } from '../db/models';
import { newId } from '../lib/id';
import { SYNC_VERSION } from './version';
import { migrateEntryData } from './migrations';
import { mergeEntity, stampUpdatedFields } from './field-timestamps';

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
} as const;

const requiredFields: Record<ChangeEntry['entityType'], string[]> = {
  taskList: ['id', 'name', 'order', 'createdAt', 'updatedAt'],
  task: ['id', 'listId', 'title', 'status', 'order', 'createdAt', 'updatedAt'],
  subtask: ['id', 'taskId', 'title', 'status', 'order', 'createdAt', 'updatedAt'],
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

  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
    for (const entry of sorted) {
      const table = tableForEntity[entry.entityType]();

      if (entry.operation === 'delete') {
        const existing = await table.get(entry.entityId);
        if (existing) {
          const localUpdatedAt = (existing as { updatedAt?: number }).updatedAt ?? 0;
          if (entry.timestamp >= localUpdatedAt) {
            const ft = stampUpdatedFields(
              (existing as unknown as Record<string, unknown>).fieldTimestamps as Record<string, number> | undefined,
              ['deletedAt'],
              entry.timestamp,
            );
            await table.update(entry.entityId, {
              deletedAt: entry.timestamp,
              updatedAt: entry.timestamp,
              fieldTimestamps: ft,
            });
          }
        }
      } else {
        // Migrate entry data from older format versions
        const data = entry.data ? migrateEntryData(entry.data, entry.entityType, entry.v) : entry.data;

        // Validate entity shape before writing
        if (!validateEntityShape(data, entry.entityType)) {
          console.warn(`Skipping malformed ${entry.entityType} entry ${entry.id}: missing required fields`);
          continue;
        }

        // upsert with field-level merge
        const existing = await table.get(entry.entityId);
        if (existing) {
          const merged = mergeEntity(
            existing as unknown as Record<string, unknown>,
            data as Record<string, unknown>,
            entry.timestamp,
          );
          if (merged) {
            await table.put(merged as never);
          }
        } else {
          await table.put(data as never);
        }
      }
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
  return oldest.length;
}
