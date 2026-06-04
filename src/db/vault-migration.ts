// One-shot migrations to encrypt/decrypt all existing rows at rest when Paranoid
// Mode is toggled on an already-populated database.
//
// Both directions go through the DBCore middleware (src/db/vault-middleware.ts),
// so they reuse the same encryption logic as normal writes:
//   - Enable: the DEK is already active, so reading a row decrypts it (or passes
//     a still-plaintext row through) and writing it back encrypts it. Idempotent,
//     so a re-run after a crash safely finishes the job.
//   - Disable: read decrypted (DEK active), then write back with the middleware
//     bypassed so plaintext lands on disk.

import type { Table } from 'dexie';
import { db } from './index';
import { setMigrationBypass } from './vault-middleware';

type ProgressFn = (done: number, total: number) => void;

function encryptedTables(): Array<Table<unknown, string>> {
  return [
    db.taskLists as unknown as Table<unknown, string>,
    db.tasks as unknown as Table<unknown, string>,
    db.subtasks as unknown as Table<unknown, string>,
    db.changeLog as unknown as Table<unknown, string>,
  ];
}

async function totalRows(tables: Array<Table<unknown, string>>): Promise<number> {
  const counts = await Promise.all(tables.map((t) => t.count()));
  return counts.reduce((a, b) => a + b, 0);
}

/** Rewrite every row so it is encrypted at rest. DEK must already be active. */
export async function encryptAllAtRest(onProgress?: ProgressFn): Promise<void> {
  const tables = encryptedTables();
  const total = await totalRows(tables);
  let done = 0;
  for (const table of tables) {
    const rows = await table.toArray();      // decrypts (or passes through plaintext)
    if (rows.length) await table.bulkPut(rows); // re-encrypts on write
    done += rows.length;
    onProgress?.(done, total);
  }
}

/** Rewrite every row back to plaintext on disk. DEK must already be active. */
export async function decryptAllAtRest(onProgress?: ProgressFn): Promise<void> {
  const tables = encryptedTables();
  const total = await totalRows(tables);
  let done = 0;
  for (const table of tables) {
    const rows = await table.toArray();      // DEK active -> decrypted in memory
    setMigrationBypass(true);
    try {
      if (rows.length) await table.bulkPut(rows); // bypass -> plaintext on disk
    } finally {
      setMigrationBypass(false);
    }
    done += rows.length;
    onProgress?.(done, total);
  }
}
