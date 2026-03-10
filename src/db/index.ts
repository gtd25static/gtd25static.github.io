import Dexie, { type Table } from 'dexie';
import type { TaskList, Task, Subtask, SyncMeta, LocalSettings, ChangeEntry } from './models';
import { newId } from '../lib/id';
import { createLocalBackup } from './backup';
import { SYNC_VERSION } from '../sync/version';
import { runLocalMigrations } from '../sync/local-migrations';

export class Gtd25DB extends Dexie {
  taskLists!: Table<TaskList, string>;
  tasks!: Table<Task, string>;
  subtasks!: Table<Subtask, string>;
  syncMeta!: Table<SyncMeta, string>;
  localSettings!: Table<LocalSettings, string>;
  changeLog!: Table<ChangeEntry, string>;

  constructor() {
    super('gtd25');
    this.version(1).stores({
      taskLists: 'id, order, deletedAt',
      tasks: 'id, listId, status, order, dueDate, deletedAt',
      subtasks: 'id, taskId, status, order, deletedAt',
      syncMeta: 'id',
      localSettings: 'id',
    });
    this.version(2).stores({
      tasks: 'id, listId, status, order, dueDate, deletedAt, createdAt',
    });
    this.version(3).stores({
      changeLog: 'id, deviceId, timestamp',
    });
  }
}

export const db = new Gtd25DB();

export async function ensureDefaults() {
  const local = await db.localSettings.get('local');
  if (!local) {
    await db.localSettings.put({
      id: 'local',
      syncEnabled: false,
      syncIntervalMs: 300_000,
      deviceId: newId(),
      appliedSyncVersion: SYNC_VERSION,
    });
  } else if (!local.deviceId) {
    await db.localSettings.update('local', { deviceId: newId() });
  }
  const meta = await db.syncMeta.get('sync-meta');
  if (!meta) {
    await db.syncMeta.put({
      id: 'sync-meta',
      pendingChanges: false,
    });
  }

  await createLocalBackup();

  // Run local migrations if needed
  const current = await db.localSettings.get('local');
  const appliedVersion = current?.appliedSyncVersion ?? 0;
  if (appliedVersion < SYNC_VERSION) {
    await runLocalMigrations(db, appliedVersion, SYNC_VERSION);
    await db.localSettings.update('local', { appliedSyncVersion: SYNC_VERSION });
  }
}
