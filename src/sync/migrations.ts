import type { SyncData, ChangeEntry } from '../db/models';

interface RemoteMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (data: SyncData) => SyncData;
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
  _entityType: ChangeEntry['entityType'],
  _entryVersion?: number,
): Record<string, unknown> {
  // Identity for now. When format changes happen, add transforms here.
  // Example: if ((entryVersion ?? 0) < 3 && 'dueDate' in data) { ... }
  return data;
}
