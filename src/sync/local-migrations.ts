import type { Gtd25DB } from '../db';

interface LocalMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (database: Gtd25DB) => Promise<void>;
}

const localMigrations: LocalMigration[] = [
  // Empty for now — add entries when SYNC_VERSION bumps with data changes.
  // Example:
  // { fromVersion: 2, toVersion: 3, migrate: async (db) => {
  //     const entries = await db.changeLog.toArray();
  //     // transform entries...
  //   }
  // },
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
