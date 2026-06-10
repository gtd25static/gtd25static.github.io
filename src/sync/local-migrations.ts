import type { Gtd25DB } from '../db';
import type { Task, Subtask } from '../db/models';
import { ensureDeviceId, recordChangeBatchInTx } from './change-log';
import { stampUpdatedFields } from './field-timestamps';

interface LocalMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (database: Gtd25DB) => Promise<void>;
}

const localMigrations: LocalMigration[] = [
  {
    fromVersion: 0,
    toVersion: 2,
    migrate: async () => {
      // No-op: versions 0–1 predate the local migration system; Dexie handles schema changes
    },
  },
  {
    fromVersion: 1,
    toVersion: 2,
    migrate: async () => {
      // No-op: version 1 predates the local migration system
    },
  },
  {
    fromVersion: 2,
    toVersion: 3,
    migrate: async () => {
      // No-op: new fields (hasWarning, warningAt, blockedAt, links, recurrence) are optional
    },
  },
  {
    fromVersion: 3,
    toVersion: 4,
    migrate: async () => {
      // No-op: the Shared Folder tables (sharedItems/sharedBlobs) are created by the
      // Dexie v7 schema; nothing to backfill.
    },
  },
  {
    // v5 removed the 'working' status (superseded by Focus Mode). Normalize any
    // local rows still carrying it to 'todo', stamping field timestamps and
    // recording change-log upserts so the normalization syncs like any edit.
    // Runs from ensureDefaults(), which only executes with the vault unlocked.
    fromVersion: 4,
    toVersion: 5,
    migrate: async (database) => {
      const [workingTasks, workingSubs]: [Task[], Subtask[]] = await Promise.all([
        database.tasks.where('status').equals('working').toArray(),
        database.subtasks.where('status').equals('working').toArray(),
      ]);
      if (workingTasks.length === 0 && workingSubs.length === 0) return;

      const now = Date.now();
      await ensureDeviceId();
      await database.transaction('rw', [database.tasks, database.subtasks, database.changeLog], async () => {
        for (const t of workingTasks) {
          const ft = stampUpdatedFields(t.fieldTimestamps, ['status'], now);
          await database.tasks.update(t.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
        }
        for (const s of workingSubs) {
          const ft = stampUpdatedFields(s.fieldTimestamps, ['status'], now);
          await database.subtasks.update(s.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
        }

        const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
        for (const t of workingTasks) {
          const updated = await database.tasks.get(t.id);
          if (updated) batch.push({ entityType: 'task', entityId: t.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
        for (const s of workingSubs) {
          const updated = await database.subtasks.get(s.id);
          if (updated) batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
        if (batch.length > 0) {
          await recordChangeBatchInTx(batch);
        }
      });
    },
  },
];

export async function runLocalMigrations(database: Gtd25DB, from: number, to: number): Promise<void> {
  if (from === to) return;

  let version = from;
  while (version < to) {
    const migration = localMigrations.find((m) => m.fromVersion === version);
    if (!migration) {
      throw new Error(`No local migration found from version ${version}`);
    }
    await migration.migrate(database);
    version = migration.toVersion;
  }
}
