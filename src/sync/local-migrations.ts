import type { Gtd25DB } from '../db';

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
