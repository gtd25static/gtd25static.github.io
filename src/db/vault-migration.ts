// One-shot migrations to encrypt/decrypt all existing rows at rest when Paranoid
// Mode is toggled on an already-populated database.
//
// CRITICAL (cross-browser correctness): all crypto happens IN MEMORY, outside any
// IndexedDB transaction. Each table is read raw (middleware bypassed), transformed
// in memory, then written back raw (middleware bypassed). No crypto.subtle ever
// runs inside a read/write transaction here. Safari's IndexedDB auto-commits a
// transaction during an in-transaction crypto await (even with Dexie.waitFor), so
// doing the bulk encrypt through the middleware threw "TransactionInactiveError"
// on enable. This approach sidesteps that entirely.
//
// Both directions are idempotent and crash-safe: rows are normalized to plaintext
// in memory first (decrypting any rows a prior interrupted run already encrypted),
// so a resumed migration finishes the job cleanly.

import type { Table } from 'dexie';
import { db } from './index';
import {
  getActiveAtRestKey, setMigrationBypass, encryptRow, decryptRow, type Row,
} from './vault-middleware';

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

/** Read a table's rows exactly as they sit on disk (no middleware transform). */
async function readRaw(table: Table<unknown, string>): Promise<Row[]> {
  setMigrationBypass(true);
  try {
    return (await table.toArray()) as Row[];
  } finally {
    setMigrationBypass(false);
  }
}

/** Write rows verbatim (no middleware transform) — so no crypto runs in the tx. */
async function writeRaw(table: Table<unknown, string>, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  setMigrationBypass(true);
  try {
    await table.bulkPut(rows);
  } finally {
    setMigrationBypass(false);
  }
}

/** Rewrite every row so it is encrypted at rest. DEK must already be active. */
export async function encryptAllAtRest(onProgress?: ProgressFn): Promise<void> {
  const key = getActiveAtRestKey();
  if (!key) throw new Error('encryptAllAtRest: no at-rest key active');
  const tables = encryptedTables();
  const total = await totalRows(tables);
  let done = 0;
  for (const table of tables) {
    const raw = await readRaw(table);
    // In memory: normalize to plaintext (decrypt anything a prior interrupted run
    // already encrypted), then encrypt. Outside any transaction. Idempotent.
    const encrypted = await Promise.all(
      raw.map(async (r) => (await encryptRow(table.name, key, (await decryptRow(table.name, key, r)) as Row)) as Row),
    );
    await writeRaw(table, encrypted);
    done += raw.length;
    onProgress?.(done, total);
  }
}

/** Rewrite every row back to plaintext on disk. DEK must already be active. */
export async function decryptAllAtRest(onProgress?: ProgressFn): Promise<void> {
  const key = getActiveAtRestKey();
  if (!key) throw new Error('decryptAllAtRest: no at-rest key active');
  const tables = encryptedTables();
  const total = await totalRows(tables);
  let done = 0;
  for (const table of tables) {
    const raw = await readRaw(table);
    const plain = await Promise.all(raw.map(async (r) => (await decryptRow(table.name, key, r)) as Row));
    await writeRaw(table, plain);
    done += raw.length;
    onProgress?.(done, total);
  }
}
