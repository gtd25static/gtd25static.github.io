import { db } from '../db';
import type { ChangeEntry } from '../db/models';
import { newId } from '../lib/id';

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
  }));
  await db.changeLog.bulkAdd(records);
}

const tableForEntity = {
  taskList: () => db.taskLists,
  task: () => db.tasks,
  subtask: () => db.subtasks,
} as const;

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
            await table.update(entry.entityId, {
              deletedAt: entry.timestamp,
              updatedAt: entry.timestamp,
            });
          }
        }
      } else {
        // upsert
        const existing = await table.get(entry.entityId);
        if (existing) {
          const localUpdatedAt = (existing as { updatedAt?: number }).updatedAt ?? 0;
          if (entry.timestamp >= localUpdatedAt) {
            await table.put(entry.data as never);
          }
        } else {
          await table.put(entry.data as never);
        }
      }
    }
  });
}

export async function getPendingEntries(): Promise<ChangeEntry[]> {
  return db.changeLog.orderBy('timestamp').toArray();
}

export async function clearPendingEntries(): Promise<void> {
  await db.changeLog.clear();
}

export function hasPendingEntries(): Promise<boolean> {
  return db.changeLog.count().then((c) => c > 0);
}
