import type { SyncData, ChangeEntry } from '../db/models';

interface RemoteMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (data: SyncData) => SyncData;
}

/**
 * v5 removed the 'working' status (superseded by Focus Mode). Map legacy rows to
 * 'todo' WITHOUT bumping fieldTimestamps: this is a value normalization, not a
 * user edit, so a genuinely fresher 'done'/'blocked' from another device still
 * wins the per-field merge. Used by the 4->5 migration and by every snapshot
 * ingestion path (bootstrap, force-pull, ZIP import, backup restore), which can
 * legitimately carry pre-v5 data forever.
 */
export function normalizeLegacyWorkingStatus<T extends { status: string }>(rows: T[]): T[] {
  return rows.map((r) => ((r.status as string) === 'working' ? { ...r, status: 'todo' } : r));
}

const migrations: RemoteMigration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    migrate: (data) => ({ ...data, syncVersion: 1 }),
  },
  {
    fromVersion: 1,
    toVersion: 2,
    migrate: (data) => ({ ...data, syncVersion: 2 }),
  },
  {
    fromVersion: 2,
    toVersion: 3,
    migrate: (data) => ({ ...data, syncVersion: 3 }),
  },
  {
    // v4 adds the Shared Folder (`sharedItems`). Additive: older snapshots simply
    // lack the field and are treated as an empty folder.
    fromVersion: 3,
    toVersion: 4,
    migrate: (data) => ({ ...data, syncVersion: 4 }),
  },
  {
    // v5 removes the 'working' task/subtask status; legacy rows become 'todo'.
    fromVersion: 4,
    toVersion: 5,
    migrate: (data) => ({
      ...data,
      tasks: normalizeLegacyWorkingStatus(data.tasks),
      subtasks: normalizeLegacyWorkingStatus(data.subtasks),
      syncVersion: 5,
    }),
  },
];

export function runRemoteMigrations(data: SyncData, from: number, to: number): SyncData {
  let current = data;
  let version = from;

  while (version < to) {
    const migration = migrations.find((m) => m.fromVersion === version);
    if (!migration) {
      throw new Error(`No migration found from version ${version}`);
    }
    current = migration.migrate(current);
    version = migration.toVersion;
  }

  return current;
}

/**
 * Normalize a single changelog entry's data from an older format version.
 * Called on each incoming remote entry before it's applied locally.
 */
export function migrateEntryData(
  data: Record<string, unknown>,
  entityType: ChangeEntry['entityType'],
  entryVersion?: number,
): Record<string, unknown> {
  // v5: entries pushed by pre-v5 devices may still carry the removed 'working' status.
  if (
    (entryVersion ?? 0) < 5 &&
    (entityType === 'task' || entityType === 'subtask') &&
    data.status === 'working'
  ) {
    return { ...data, status: 'todo' };
  }
  return data;
}
