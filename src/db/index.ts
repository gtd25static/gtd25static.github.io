import Dexie, { type Table } from 'dexie';
import type { TaskList, Task, Subtask, SyncMeta, LocalSettings, ChangeEntry, PomodoroSound, SoundPreset, PomodoroSettings } from './models';
import { newId } from '../lib/id';
import { createLocalBackup } from './backup';
import { purgeOldTrashItems } from './purge';
import { ensureDeviceId, recordChangeBatchInTx, pruneChangelogIfSyncDisabled } from '../sync/change-log';
import { stampUpdatedFields } from '../sync/field-timestamps';
import { SYNC_VERSION } from '../sync/version';
import { runLocalMigrations } from '../sync/local-migrations';

export class Gtd25DB extends Dexie {
  taskLists!: Table<TaskList, string>;
  tasks!: Table<Task, string>;
  subtasks!: Table<Subtask, string>;
  syncMeta!: Table<SyncMeta, string>;
  localSettings!: Table<LocalSettings, string>;
  changeLog!: Table<ChangeEntry, string>;
  pomodoroSounds!: Table<PomodoroSound, string>;
  soundPresets!: Table<SoundPreset, string>;
  pomodoroSettings!: Table<PomodoroSettings, string>;

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
    this.version(4).stores({
      tasks: 'id, listId, status, order, dueDate, deletedAt, createdAt, hasWarning, nextOccurrence',
      subtasks: 'id, taskId, status, order, deletedAt, hasWarning',
    });
    this.version(5).stores({
      pomodoroSounds: 'id',
      soundPresets: 'id',
      pomodoroSettings: 'id',
    });
  }
}

export const db = new Gtd25DB();

export async function cleanOrphans() {
  const now = Date.now();
  let orphanedSubtasks = 0;
  let orphanedTasks = 0;

  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
    const changeBatch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    // Find subtasks whose parent task doesn't exist
    const taskIds = new Set((await db.tasks.toArray()).map((t) => t.id));
    const allSubtasks = await db.subtasks.toArray();
    for (const sub of allSubtasks) {
      if (!taskIds.has(sub.taskId) && !sub.deletedAt) {
        const ft = stampUpdatedFields(sub.fieldTimestamps, ['deletedAt'], now);
        await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        const updated = await db.subtasks.get(sub.id);
        if (updated) changeBatch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        orphanedSubtasks++;
      }
    }

    // Find tasks whose parent list doesn't exist → move to Inbox or soft-delete
    const listIds = new Set((await db.taskLists.toArray()).map((l) => l.id));
    const allTasks = await db.tasks.toArray();
    const inbox = allTasks.length > 0
      ? (await db.taskLists.toArray()).find((l) => !l.deletedAt && l.name === 'Inbox' && l.type === 'tasks')
      : undefined;

    for (const task of allTasks) {
      if (!listIds.has(task.listId) && !task.deletedAt) {
        if (inbox) {
          const ft = stampUpdatedFields(task.fieldTimestamps, ['listId'], now);
          await db.tasks.update(task.id, { listId: inbox.id, updatedAt: now, fieldTimestamps: ft });
        } else {
          const ft = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
          await db.tasks.update(task.id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        }
        const updated = await db.tasks.get(task.id);
        if (updated) changeBatch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        orphanedTasks++;
      }
    }

    if (changeBatch.length > 0) {
      await recordChangeBatchInTx(changeBatch);
    }
  });

  if (orphanedSubtasks > 0 || orphanedTasks > 0) {
    console.warn(`Orphan cleanup: ${orphanedSubtasks} subtask(s), ${orphanedTasks} task(s)`);
  }
}

export async function ensureDefaults() {
  // Seed pomodoro settings
  const pomSettings = await db.pomodoroSettings.get('pomodoro');
  if (!pomSettings) {
    await db.pomodoroSettings.put({
      id: 'pomodoro',
      masterVolume: 0.7,
      tickingEnabled: true,
      bellEnabled: true,
      activePresetId: null,
      updatedAt: Date.now(),
      dynamicMixEnabled: false,
    });
  }

  await db.transaction('rw', [db.localSettings, db.syncMeta], async () => {
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
  });

  // Clean orphaned records
  await cleanOrphans();

  // Purge soft-deleted items older than 30 days at startup
  await purgeOldTrashItems();

  // Cap changelog when sync is disabled to prevent unbounded growth
  await pruneChangelogIfSyncDisabled();

  // Defer backup so it doesn't block initial render
  setTimeout(() => createLocalBackup(), 5000);

  // Run local migrations if needed
  const current = await db.localSettings.get('local');
  const appliedVersion = current?.appliedSyncVersion ?? 0;
  if (appliedVersion < SYNC_VERSION) {
    await runLocalMigrations(db, appliedVersion, SYNC_VERSION);
    await db.localSettings.update('local', { appliedSyncVersion: SYNC_VERSION });
  }
}
