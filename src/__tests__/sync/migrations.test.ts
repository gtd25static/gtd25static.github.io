import { runRemoteMigrations } from '../../sync/migrations';
import { SYNC_VERSION } from '../../sync/version';
import type { SyncData, Settings } from '../../db/models';

function makeSettings(overrides?: Partial<Settings>): Settings {
  return { theme: 'light', keyboardShortcuts: {}, ...overrides };
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
});
