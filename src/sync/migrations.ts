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
  {
    // v6 adds Mindmaps (mindmapFolders/mindmaps/mindmapNodes). Additive: older
    // snapshots simply lack the fields and are treated as no mindmaps.
    fromVersion: 5,
    toVersion: 6,
    migrate: (data) => ({ ...data, syncVersion: 6 }),
  },
  {
    // v7 moves `fieldTimestamps` inside each record's encrypted blob (it named
    // the encrypted fields and when each changed). Nothing to rewrite here: a
    // v6 snapshot carries it as a plaintext top-level field, `decryptEntity`
    // leaves that copy in place when the blob has none, and the next write of
    // each record moves it inside. Records converge lazily, no data touched.
    fromVersion: 6,
    toVersion: 7,
    migrate: (data) => ({ ...data, syncVersion: 7 }),
  },
  {
    // v8 adds `taskList.savedSearches`, an encrypted field. Additive: older
    // snapshots simply lack it. The bump is the point — a v7 build doesn't know
    // the field is sensitive and would write it back in the clear (on the wire
    // and at rest), so it must stop syncing ("update required") instead.
    fromVersion: 7,
    toVersion: 8,
    migrate: (data) => ({ ...data, syncVersion: 8 }),
  },
  {
    // v9 pads Shared Folder files on the wire (framed + Padmé length, new AAD).
    // Nothing to rewrite: older files stay readable and gain the padding at the
    // next sync-password change. The bump is the point — a v8 build cannot open
    // a padded file, and its sync-password change would keep such files under
    // the old key (counted unreadable), losing them; it must update first.
    fromVersion: 8,
    toVersion: 9,
    migrate: (data) => ({ ...data, syncVersion: 9 }),
  },
  {
    // v10 change entries carry the writer's `_base` (sync/conflicts.ts), so the
    // receiving device can tell a concurrent edit from a later one. Nothing to
    // rewrite. The bump is the point — a v9 build would merge `_base` into its
    // rows as if it were a field, push it back in the clear inside entries'
    // plaintext part, and hand stale bases to every other device.
    fromVersion: 9,
    toVersion: 10,
    migrate: (data) => ({ ...data, syncVersion: 10 }),
  },
  {
    // v11 adds `taskList.notDuplicates`, an encrypted field (pairs of tasks the
    // user said are not duplicates). Additive: older snapshots simply lack it. The
    // bump is the point, as in v8 — a v10 build would write it back in the clear.
    fromVersion: 10,
    toVersion: 11,
    migrate: (data) => ({ ...data, syncVersion: 11 }),
  },
  {
    // v12 adds `sharedItem.expiresAt`, an encrypted field (what a Paranoid Mode
    // device adds to the Shared Folder is deleted 24 h later). Additive: older
    // snapshots lack it. The bump is the point — a v11 build would write it back
    // in the clear, and would never delete the item.
    fromVersion: 11,
    toVersion: 12,
    migrate: (data) => ({ ...data, syncVersion: 12 }),
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
