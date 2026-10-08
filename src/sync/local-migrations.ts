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
  {
    fromVersion: 5,
    toVersion: 6,
    migrate: async () => {
      // No-op: the Mindmaps tables (mindmapFolders/mindmaps/mindmapNodes) are
      // created by the Dexie v8 schema; nothing to backfill.
    },
  },
  {
    // No-op: v7 moved fieldTimestamps inside the encrypted blob, which each row
    // does on its next write. (Missing until 2026-10: every start since v7 threw.)
    fromVersion: 6,
    toVersion: 7,
    migrate: async () => {},
  },
  {
    // No-op: v8 added taskList.savedSearches, absent on older rows.
    fromVersion: 7,
    toVersion: 8,
    migrate: async () => {},
  },
  {
    // No-op: v9 pads Shared Folder files on the wire; the local cache keeps
    // plaintext bytes as before.
    fromVersion: 8,
    toVersion: 9,
    migrate: async () => {},
  },
  {
    // v10: rows gain `_base` (sync/conflicts.ts) as remote changes reach them.
    // Until then a row's base is implicit — its field timestamps up to now —
    // rather than rewriting every row (a whole re-encryption in Paranoid Mode).
    fromVersion: 9,
    toVersion: 10,
    migrate: async (database) => {
      const meta = await database.syncMeta.get('sync-meta');
      if (!meta?.conflictBaseSince) await database.syncMeta.update('sync-meta', { conflictBaseSince: Date.now() });
    },
  },
  {
    // No-op: v11 added taskList.notDuplicates, absent on older rows.
    fromVersion: 10,
    toVersion: 11,
    migrate: async () => {},
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
