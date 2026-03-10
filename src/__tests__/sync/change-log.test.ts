import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  recordChange,
  recordChangeBatch,
  getPendingEntries,
  clearPendingEntries,
  clearEntriesByIds,
  pendingEntryCount,
  hasPendingEntries,
  applyRemoteEntries,
} from '../../sync/change-log';
import { newId } from '../../lib/id';
import { SYNC_VERSION } from '../../sync/version';

beforeEach(async () => {
  await resetDb();
});

describe('recordChange', () => {
  it('adds entry with correct fields', async () => {
    await recordChange('task', 'task-1', 'upsert', { id: 'task-1', title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0].entityType).toBe('task');
    expect(entries[0].entityId).toBe('task-1');
    expect(entries[0].operation).toBe('upsert');
    expect(entries[0].data).toEqual({ id: 'task-1', title: 'Test' });
    expect(entries[0].timestamp).toBeGreaterThan(0);
    expect(entries[0].id).toBeTruthy();
  });

  it('uses deviceId from localSettings', async () => {
    await db.localSettings.update('local', { deviceId: 'my-device-42' });
    await recordChange('taskList', 'list-1', 'upsert');
    const entries = await db.changeLog.toArray();
    expect(entries[0].deviceId).toBe('my-device-42');
  });

  it('includes v: SYNC_VERSION in entries', async () => {
    await recordChange('task', 'task-1', 'upsert', { id: 'task-1', title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries[0].v).toBe(SYNC_VERSION);
  });
});

describe('recordChangeBatch', () => {
  it('adds multiple entries with shared timestamp and deviceId', async () => {
    await db.localSettings.update('local', { deviceId: 'batch-device' });
    await recordChangeBatch([
      { entityType: 'task', entityId: 't1', operation: 'upsert' },
      { entityType: 'subtask', entityId: 's1', operation: 'delete' },
      { entityType: 'taskList', entityId: 'l1', operation: 'upsert' },
    ]);
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(3);
    // All share the same timestamp and deviceId
    expect(new Set(entries.map((e) => e.timestamp)).size).toBe(1);
    expect(new Set(entries.map((e) => e.deviceId)).size).toBe(1);
    expect(entries[0].deviceId).toBe('batch-device');
  });

  it('no-ops on empty array', async () => {
    await recordChangeBatch([]);
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(0);
  });

  it('includes v: SYNC_VERSION in batch entries', async () => {
    await recordChangeBatch([
      { entityType: 'task', entityId: 't1', operation: 'upsert' },
      { entityType: 'subtask', entityId: 's1', operation: 'delete' },
    ]);
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(2);
    entries.forEach((e) => expect(e.v).toBe(SYNC_VERSION));
  });
});

describe('getPendingEntries', () => {
  it('returns entries ordered by timestamp', async () => {
    // Insert with explicit timestamps via direct db access
    const now = Date.now();
    await db.changeLog.bulkAdd([
      { id: 'e1', deviceId: 'd', timestamp: now + 200, entityType: 'task', entityId: 't1', operation: 'upsert' },
      { id: 'e2', deviceId: 'd', timestamp: now + 100, entityType: 'task', entityId: 't2', operation: 'upsert' },
      { id: 'e3', deviceId: 'd', timestamp: now + 300, entityType: 'task', entityId: 't3', operation: 'upsert' },
    ]);
    const entries = await getPendingEntries();
    expect(entries.map((e) => e.id)).toEqual(['e2', 'e1', 'e3']);
  });

  it('respects limit', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await db.changeLog.add({
        id: `e${i}`, deviceId: 'd', timestamp: now + i,
        entityType: 'task', entityId: `t${i}`, operation: 'upsert',
      });
    }
    const entries = await getPendingEntries(3);
    expect(entries).toHaveLength(3);
  });

  it('returns empty array when no entries', async () => {
    const entries = await getPendingEntries();
    expect(entries).toEqual([]);
  });
});

describe('clearPendingEntries', () => {
  it('removes all entries', async () => {
    await db.changeLog.bulkAdd([
      { id: 'e1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert' },
      { id: 'e2', deviceId: 'd', timestamp: 2, entityType: 'task', entityId: 't2', operation: 'upsert' },
    ]);
    await clearPendingEntries();
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('clearEntriesByIds', () => {
  it('removes only specified entries', async () => {
    await db.changeLog.bulkAdd([
      { id: 'e1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert' },
      { id: 'e2', deviceId: 'd', timestamp: 2, entityType: 'task', entityId: 't2', operation: 'upsert' },
      { id: 'e3', deviceId: 'd', timestamp: 3, entityType: 'task', entityId: 't3', operation: 'upsert' },
    ]);
    await clearEntriesByIds(['e1', 'e3']);
    const remaining = await db.changeLog.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('e2');
  });

  it('leaves others intact when clearing nonexistent ids', async () => {
    await db.changeLog.add({
      id: 'e1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert',
    });
    await clearEntriesByIds(['nonexistent']);
    expect(await db.changeLog.count()).toBe(1);
  });
});

describe('pendingEntryCount / hasPendingEntries', () => {
  it('returns correct count', async () => {
    expect(await pendingEntryCount()).toBe(0);
    await db.changeLog.add({
      id: 'e1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert',
    });
    expect(await pendingEntryCount()).toBe(1);
  });

  it('hasPendingEntries returns false when empty', async () => {
    expect(await hasPendingEntries()).toBe(false);
  });

  it('hasPendingEntries returns true when entries exist', async () => {
    await db.changeLog.add({
      id: 'e1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert',
    });
    expect(await hasPendingEntries()).toBe(true);
  });
});

describe('applyRemoteEntries — upsert', () => {
  it('creates new entity', async () => {
    const taskId = newId();
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Remote Task', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    }]);
    const task = await db.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Remote Task');
  });

  it('overwrites when remote timestamp >= local', async () => {
    const taskId = newId();
    const now = Date.now();
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'Local', status: 'todo', order: 0,
      createdAt: now, updatedAt: now,
    });
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now + 100,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Remote', status: 'done', order: 0, createdAt: now, updatedAt: now + 100 },
    }]);
    const task = await db.tasks.get(taskId);
    expect(task!.title).toBe('Remote');
    expect(task!.status).toBe('done');
  });

  it('skips when local is newer', async () => {
    const taskId = newId();
    const now = Date.now();
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'Local', status: 'todo', order: 0,
      createdAt: now, updatedAt: now + 500,
    });
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now + 100,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Remote', status: 'done', order: 0, createdAt: now, updatedAt: now + 100 },
    }]);
    const task = await db.tasks.get(taskId);
    expect(task!.title).toBe('Local');
  });
});

describe('applyRemoteEntries — delete', () => {
  it('sets deletedAt when remote >= local', async () => {
    const taskId = newId();
    const now = Date.now();
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'To Delete', status: 'todo', order: 0,
      createdAt: now, updatedAt: now,
    });
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now + 100,
      entityType: 'task', entityId: taskId, operation: 'delete',
    }]);
    const task = await db.tasks.get(taskId);
    expect(task!.deletedAt).toBe(now + 100);
  });

  it('skips when local is newer', async () => {
    const taskId = newId();
    const now = Date.now();
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'Keep', status: 'todo', order: 0,
      createdAt: now, updatedAt: now + 500,
    });
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now + 100,
      entityType: 'task', entityId: taskId, operation: 'delete',
    }]);
    const task = await db.tasks.get(taskId);
    expect(task!.deletedAt).toBeUndefined();
  });

  it('no-ops for nonexistent entity', async () => {
    // Should not throw
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: Date.now(),
      entityType: 'task', entityId: 'nonexistent', operation: 'delete',
    }]);
    const task = await db.tasks.get('nonexistent');
    expect(task).toBeUndefined();
  });
});

describe('applyRemoteEntries — ordering', () => {
  it('processes in timestamp order; last-write-wins for same entity', async () => {
    const taskId = newId();
    const now = Date.now();
    // Two upserts for same entity — later one should win
    await applyRemoteEntries([
      {
        id: 'e2', deviceId: 'remote', timestamp: now + 200,
        entityType: 'task', entityId: taskId, operation: 'upsert',
        data: { id: taskId, listId: 'list-1', title: 'Second', status: 'done', order: 0, createdAt: now, updatedAt: now + 200 },
      },
      {
        id: 'e1', deviceId: 'remote', timestamp: now + 100,
        entityType: 'task', entityId: taskId, operation: 'upsert',
        data: { id: taskId, listId: 'list-1', title: 'First', status: 'todo', order: 0, createdAt: now, updatedAt: now + 100 },
      },
    ]);
    const task = await db.tasks.get(taskId);
    expect(task!.title).toBe('Second');
  });

  it('handles create-then-delete sequence', async () => {
    const taskId = newId();
    const now = Date.now();
    await applyRemoteEntries([
      {
        id: 'e1', deviceId: 'remote', timestamp: now,
        entityType: 'task', entityId: taskId, operation: 'upsert',
        data: { id: taskId, listId: 'list-1', title: 'Created', status: 'todo', order: 0, createdAt: now, updatedAt: now },
      },
      {
        id: 'e2', deviceId: 'remote', timestamp: now + 100,
        entityType: 'task', entityId: taskId, operation: 'delete',
      },
    ]);
    const task = await db.tasks.get(taskId);
    expect(task!.deletedAt).toBe(now + 100);
  });

  it('handles delete-then-recreate sequence', async () => {
    const taskId = newId();
    const now = Date.now();
    // Pre-existing entity
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'Original', status: 'todo', order: 0,
      createdAt: now - 100, updatedAt: now - 100,
    });
    await applyRemoteEntries([
      {
        id: 'e1', deviceId: 'remote', timestamp: now,
        entityType: 'task', entityId: taskId, operation: 'delete',
      },
      {
        id: 'e2', deviceId: 'remote', timestamp: now + 100,
        entityType: 'task', entityId: taskId, operation: 'upsert',
        data: { id: taskId, listId: 'list-1', title: 'Recreated', status: 'todo', order: 0, createdAt: now + 100, updatedAt: now + 100 },
      },
    ]);
    const task = await db.tasks.get(taskId);
    expect(task!.title).toBe('Recreated');
    // deletedAt should be gone since the upsert replaces with put()
  });

  it('works with taskList entityType', async () => {
    const listId = newId();
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'taskList', entityId: listId, operation: 'upsert',
      data: { id: listId, name: 'Remote List', type: 'tasks', order: 0, createdAt: now, updatedAt: now },
    }]);
    const list = await db.taskLists.get(listId);
    expect(list!.name).toBe('Remote List');
  });

  it('works with subtask entityType', async () => {
    const subtaskId = newId();
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'subtask', entityId: subtaskId, operation: 'upsert',
      data: { id: subtaskId, taskId: 'task-1', title: 'Remote Sub', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    }]);
    const sub = await db.subtasks.get(subtaskId);
    expect(sub!.title).toBe('Remote Sub');
  });
});

describe('applyRemoteEntries — entity shape validation', () => {
  it('skips entry with missing required fields', async () => {
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: 'bad-task', operation: 'upsert',
      data: { id: 'bad-task', title: 'Missing listId' }, // Missing listId, status, order, etc.
    }]);
    const task = await db.tasks.get('bad-task');
    expect(task).toBeUndefined();
  });

  it('skips entry with undefined data', async () => {
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: 'no-data', operation: 'upsert',
      // data is undefined
    }]);
    const task = await db.tasks.get('no-data');
    expect(task).toBeUndefined();
  });

  it('accepts entry with extra unknown fields', async () => {
    const taskId = newId();
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: {
        id: taskId, listId: 'list-1', title: 'Task', status: 'todo', order: 0,
        createdAt: now, updatedAt: now,
        futureField: 'some-value', anotherNewField: 42, // Unknown fields
      },
    }]);
    const task = await db.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Task');
  });

  it('validates taskList shape', async () => {
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'taskList', entityId: 'bad-list', operation: 'upsert',
      data: { id: 'bad-list' }, // Missing name, order, etc.
    }]);
    const list = await db.taskLists.get('bad-list');
    expect(list).toBeUndefined();
  });

  it('validates subtask shape', async () => {
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'subtask', entityId: 'bad-sub', operation: 'upsert',
      data: { id: 'bad-sub', title: 'Sub' }, // Missing taskId, status, order, etc.
    }]);
    const sub = await db.subtasks.get('bad-sub');
    expect(sub).toBeUndefined();
  });

  it('does not validate shape for delete operations', async () => {
    const taskId = newId();
    const now = Date.now();
    // First create the task
    await db.tasks.add({
      id: taskId, listId: 'list-1', title: 'To Delete', status: 'todo', order: 0,
      createdAt: now, updatedAt: now,
    });
    // Delete should work without data validation
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now + 100,
      entityType: 'task', entityId: taskId, operation: 'delete',
      // No data field for delete
    }]);
    const task = await db.tasks.get(taskId);
    expect(task!.deletedAt).toBe(now + 100);
  });
});

describe('applyRemoteEntries — entry migration', () => {
  it('applies entries from older versions (migrateEntryData passthrough)', async () => {
    const taskId = newId();
    const now = Date.now();
    // Entry with no version (old device) should still apply
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Old Format', status: 'todo', order: 0, createdAt: now, updatedAt: now },
      // no v field
    }]);
    const task = await db.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Old Format');
  });

  it('applies entries with explicit version', async () => {
    const taskId = newId();
    const now = Date.now();
    await applyRemoteEntries([{
      id: 'e1', deviceId: 'remote', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Versioned', status: 'todo', order: 0, createdAt: now, updatedAt: now },
      v: SYNC_VERSION,
    }]);
    const task = await db.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Versioned');
  });
});
