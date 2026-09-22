// The content tables the vault key protects, and the two halves of "rewrite all
// of it under another key": read everything decrypted, then pre-encrypt it in
// memory. Shared by the operations that swap the whole vault in one transaction.
// The crypto happens here, outside IndexedDB, because Safari auto-commits a
// transaction during an in-transaction crypto await.

import type { Table } from 'dexie';
import { db } from './index';
import { encryptRow, type Row } from './vault-middleware';

export const CONTENT_TABLES: Array<{ name: string; entityType: string; table: () => Table<unknown, string> }> = [
  { name: 'taskLists', entityType: 'taskList', table: () => db.taskLists as unknown as Table<unknown, string> },
  { name: 'tasks', entityType: 'task', table: () => db.tasks as unknown as Table<unknown, string> },
  { name: 'subtasks', entityType: 'subtask', table: () => db.subtasks as unknown as Table<unknown, string> },
  { name: 'sharedItems', entityType: 'sharedItem', table: () => db.sharedItems as unknown as Table<unknown, string> },
  { name: 'mindmapFolders', entityType: 'mindmapFolder', table: () => db.mindmapFolders as unknown as Table<unknown, string> },
  { name: 'mindmaps', entityType: 'mindmap', table: () => db.mindmaps as unknown as Table<unknown, string> },
  { name: 'mindmapNodes', entityType: 'mindmapNode', table: () => db.mindmapNodes as unknown as Table<unknown, string> },
];

/**
 * Every content row, read through the middleware (a DEK must be active). A row
 * still carrying `_enc` was read WITHOUT the key: it would be carried into the
 * new vault as ciphertext nobody can open, so this refuses before anything is
 * written.
 */
export async function readContentRows(): Promise<Map<string, Row[]>> {
  const rowsByTable = new Map<string, Row[]>();
  for (const t of CONTENT_TABLES) {
    const rows = (await t.table().toArray()) as Row[];
    if (rows.some((r) => r._enc !== undefined)) throw new Error(`${t.name} read without the vault key`);
    rowsByTable.set(t.name, rows);
  }
  return rowsByTable;
}

/** Pre-encrypt every row under `dek`, in memory, after an optional per-row transform. */
export async function encryptContentRows(
  dek: CryptoKey,
  rowsByTable: Map<string, Row[]>,
  transform?: (entityType: string, row: Row) => Row,
): Promise<Map<string, Row[]>> {
  const encByTable = new Map<string, Row[]>();
  for (const t of CONTENT_TABLES) {
    const rows = rowsByTable.get(t.name) ?? [];
    const enc = await Promise.all(
      rows.map((r) => encryptRow(t.name, dek, transform ? transform(t.entityType, r) : r) as Promise<Row>),
    );
    encByTable.set(t.name, enc);
  }
  return encByTable;
}
