import { runRemoteMigrations, migrateEntryData } from '../../sync/migrations';
import { SYNC_VERSION } from '../../sync/version';
import type { SyncData, Settings } from '../../db/models';

function makeSettings(overrides?: Partial<Settings>): Settings {
  return { theme: 'light', ...overrides };
}

function makeSyncData(overrides?: Partial<SyncData>): SyncData {
  return { taskLists: [], tasks: [], subtasks: [], settings: makeSettings(), ...overrides };
}

describe('runRemoteMigrations', () => {
  it('migrates from 0 to 1 by adding syncVersion', () => {
    const data = makeSyncData();
    const result = runRemoteMigrations(data, 0, 1);
    expect(result.syncVersion).toBe(1);
  });

  it('preserves existing data during migration', () => {
    const data = makeSyncData({
      taskLists: [{ id: 'l1', name: 'Test', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1000 }],
    });
    const result = runRemoteMigrations(data, 0, 1);
    expect(result.taskLists).toHaveLength(1);
    expect(result.taskLists[0].name).toBe('Test');
    expect(result.settings).toEqual(data.settings);
  });

  it('is a no-op when from equals to', () => {
    const data = makeSyncData({ syncVersion: 1 });
    const result = runRemoteMigrations(data, 1, 1);
    expect(result).toEqual(data);
  });

  it('throws when no migration path exists', () => {
    const data = makeSyncData();
    expect(() => runRemoteMigrations(data, 99, 100)).toThrow('No migration found from version 99');
  });

  it('can migrate from 0 to SYNC_VERSION', () => {
    const data = makeSyncData();
    const result = runRemoteMigrations(data, 0, SYNC_VERSION);
    expect(result.syncVersion).toBe(SYNC_VERSION);
  });

  it('4 -> 5 normalizes legacy working statuses without touching fieldTimestamps', () => {
    const ft = { status: 12345 };
    const data = makeSyncData({
      syncVersion: 4,
      tasks: [
        { id: 't1', listId: 'l1', title: 'Legacy', status: 'working', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: ft } as unknown as SyncData['tasks'][number],
        { id: 't2', listId: 'l1', title: 'Done', status: 'done', order: 1, createdAt: 1, updatedAt: 1 },
      ],
      subtasks: [
        { id: 's1', taskId: 't1', title: 'Legacy sub', status: 'working', order: 0, createdAt: 1, updatedAt: 1 } as unknown as SyncData['subtasks'][number],
      ],
    });
    const result = runRemoteMigrations(data, 4, 5);
    expect(result.syncVersion).toBe(5);
    expect(result.tasks[0].status).toBe('todo');
    expect(result.tasks[0].fieldTimestamps).toEqual(ft); // value normalization, not a user edit
    expect(result.tasks[1].status).toBe('done');
    expect(result.subtasks[0].status).toBe('todo');
  });
});

describe('migrateEntryData', () => {
  it('returns data unchanged (identity)', () => {
    const data = { id: 't1', listId: 'l1', title: 'Test', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000 };
    const result = migrateEntryData(data, 'task', SYNC_VERSION);
    expect(result).toEqual(data);
  });

  it('returns data unchanged when version is undefined', () => {
    const data = { id: 't1', listId: 'l1', title: 'Test', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000 };
    const result = migrateEntryData(data, 'task', undefined);
    expect(result).toEqual(data);
  });

  it('is idempotent', () => {
    const data = { id: 't1', listId: 'l1', title: 'Test', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000 };
    const first = migrateEntryData(data, 'task', 1);
    const second = migrateEntryData(first, 'task', 1);
    expect(second).toEqual(first);
  });

  it('works for all entity types', () => {
    const taskData = { id: 't1', listId: 'l1', title: 'T', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 };
    const listData = { id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 };
    const subData = { id: 's1', taskId: 't1', title: 'S', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 };
    expect(migrateEntryData(taskData, 'task', 1)).toEqual(taskData);
    expect(migrateEntryData(listData, 'taskList', 1)).toEqual(listData);
    expect(migrateEntryData(subData, 'subtask', 1)).toEqual(subData);
  });

  it('normalizes the legacy working status on pre-v5 task/subtask entries', () => {
    const taskData = { id: 't1', listId: 'l1', title: 'T', status: 'working', order: 0, createdAt: 1, updatedAt: 1 };
    const subData = { id: 's1', taskId: 't1', title: 'S', status: 'working', order: 0, createdAt: 1, updatedAt: 1 };
    expect(migrateEntryData(taskData, 'task', 4).status).toBe('todo');
    expect(migrateEntryData(subData, 'subtask', 4).status).toBe('todo');
    expect(migrateEntryData(taskData, 'task', undefined).status).toBe('todo'); // versionless = oldest
  });

  it('leaves v5+ entries and non-working statuses alone', () => {
    const v5Data = { id: 't1', listId: 'l1', title: 'T', status: 'working', order: 0, createdAt: 1, updatedAt: 1 };
    expect(migrateEntryData(v5Data, 'task', 5)).toEqual(v5Data);
    const todoData = { id: 't1', listId: 'l1', title: 'T', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 };
    expect(migrateEntryData(todoData, 'task', 4)).toEqual(todoData);
  });
});
