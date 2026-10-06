import type { Transaction } from 'dexie';
import { db } from './index';

// What a row is AS STORED — read with plain IndexedDB, below the vault
// middleware, so nothing is decrypted (no Web Crypto inside a write transaction:
// Safari closes it). On a Paranoid device the ciphertext (`_enc`, a fresh IV on
// every write) identifies a version; otherwise the row itself does.

function storedRowIn(tx: Transaction, tableName: string, id: string): Promise<unknown> {
  const store = (tx as unknown as { idbtrans: IDBTransaction }).idbtrans.objectStore(tableName);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function versionOf(row: unknown): string {
  if (row && typeof row === 'object' && typeof (row as { _enc?: unknown })._enc === 'string') return (row as { _enc: string })._enc;
  return JSON.stringify(row ?? null);
}

/** The stored version of a row, read in a transaction of its own. */
export function storedVersion(tableName: 'tasks' | 'subtasks', id: string): Promise<string> {
  return db.transaction('r', db.table(tableName), (tx) => storedRowIn(tx, tableName, id)).then(versionOf);
}

/** The stored version of a row, read inside the caller's transaction (which must cover the table). */
export async function storedVersionInTx(tx: Transaction, tableName: 'tasks' | 'subtasks', id: string): Promise<string> {
  return versionOf(await storedRowIn(tx, tableName, id));
}
