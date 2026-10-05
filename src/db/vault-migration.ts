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
import { recordError } from '../lib/diagnostics';

type ProgressFn = (done: number, total: number) => void;

function encryptedTables(): Array<Table<unknown, string>> {
  return [
    db.taskLists as unknown as Table<unknown, string>,
    db.tasks as unknown as Table<unknown, string>,
    db.subtasks as unknown as Table<unknown, string>,
    db.changeLog as unknown as Table<unknown, string>,
    db.sharedItems as unknown as Table<unknown, string>,
    db.mindmapFolders as unknown as Table<unknown, string>,
    db.mindmaps as unknown as Table<unknown, string>,
    db.mindmapNodes as unknown as Table<unknown, string>,
    db.syncConflicts as unknown as Table<unknown, string>,
  ];
}

// The Shared Folder blob cache (binary, not middleware-handled) just mirrors the
// backend. On any at-rest regime flip we drop it rather than re-encrypt binary in
// place; the next open re-downloads and re-caches under the new regime.
async function clearSharedBlobCache(): Promise<void> {
  try {
    await db.sharedBlobs.clear();
  } catch (err) {
    recordError('vault-migration:sharedBlobs', err);
  }
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
  } catch (err) {
    recordError(`vault-migration:${table.name}`, err);
    // Surface storage exhaustion clearly — the migration is idempotent/resumable,
    // so the half-written state is safe to retry once space is freed.
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error('Not enough storage to complete the at-rest migration. Free up space and try again.');
    }
    throw err;
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
    // Read plaintext THROUGH the middleware (decrypts any rows a prior interrupted
    // run already encrypted; passes plaintext through on a first run), encrypt IN
    // MEMORY (not inside the write tx — Safari-safe), then write the pre-encrypted
    // rows back through the NORMAL middleware: encryptRow passes through rows that
    // already carry `_enc`, so no crypto runs in the write tx AND there is no
    // global bypass window for a concurrent liveQuery to read raw `_enc` from
    // (which is what left e.g. sidebar list names blank right after enabling).
    const plain = (await table.toArray()) as Row[];
    const encrypted = await Promise.all(plain.map((r) => encryptRow(table.name, key, r) as Promise<Row>));
    if (encrypted.length) await table.bulkPut(encrypted as unknown[]);
    done += plain.length;
    onProgress?.(done, total);
  }
  await clearSharedBlobCache();
}

const UNREADABLE = Symbol('unreadable');

async function tryDecryptRow(table: string, key: CryptoKey, row: Row): Promise<Row | typeof UNREADABLE> {
  try {
    return (await decryptRow(table, key, row)) as Row;
  } catch {
    return UNREADABLE;
  }
}

/**
 * How many stored rows the active key cannot open (corrupt, or written under
 * another key) — what a disable would have to drop. Read through the
 * middleware, which quarantines exactly those (`_decryptError`, the same
 * decrypt as decryptAllAtRest): reading raw opened the module-wide bypass, and
 * a sync merging in this tab meanwhile read ciphertext rows and wrote them back
 * holding only their base — their content gone. Read-only.
 */
export async function countUnreadableAtRest(): Promise<number> {
  let unreadable = 0;
  for (const table of encryptedTables()) {
    const rows = (await table.toArray()) as Row[];
    unreadable += rows.filter((r) => r._decryptError === true).length;
  }
  return unreadable;
}

/**
 * Rewrite every row still encrypted under `key` back to plaintext on disk. Takes
 * the key explicitly: the disable runs a last pass after the Paranoid flag is
 * down, when no at-rest key is active any more (see vault.completeDisable).
 *
 * A row the key cannot open is deleted (and counted in the diagnostics log):
 * nothing can ever read it, and one such row used to make every disable — and,
 * through the resume, every unlock — fail, with a panic wipe the only way out.
 * The disable asks before it starts (countUnreadableAtRest). Returns how many.
 */
export async function decryptAllAtRest(key: CryptoKey, onProgress?: ProgressFn): Promise<number> {
  const tables = encryptedTables();
  const total = await totalRows(tables);
  let done = 0;
  let dropped = 0;
  for (const table of tables) {
    const raw = await readRaw(table);
    const plain = await Promise.all(raw.map((r) => tryDecryptRow(table.name, key, r)));
    const unreadable = raw.filter((_, i) => plain[i] === UNREADABLE).map((r) => String(r.id));
    // Only the rows that were still encrypted (decryptRow hands a plaintext row
    // back as is): rewriting the others gains nothing and could undo a write
    // that landed since the read, and it keeps the disable's last pass cheap.
    await writeRaw(table, plain.filter((row, i): row is Row => row !== UNREADABLE && row !== raw[i]));
    if (unreadable.length) {
      await table.bulkDelete(unreadable);
      dropped += unreadable.length;
      recordError(`vault-migration:${table.name}`, new Error(`Dropped ${unreadable.length} unreadable row(s) while turning Paranoid Mode off`));
    }
    done += raw.length;
    onProgress?.(done, total);
  }
  await clearSharedBlobCache();
  return dropped;
}

/**
 * Whether a stored row is anything but plain at-rest ciphertext: `fieldTimestamps`
 * beside its ciphertext (written before SYNC_VERSION 7 moved it inside: which
 * fields exist and when each changed, readable from a locked disk), or no
 * ciphertext at all (a row a forged `_enc` had left in plaintext — closed in
 * batch 1 of the 2026-10 review, but such a row stayed so until edited).
 */
function needsRewrite(table: string, row: Row): boolean {
  const target = table === 'changeLog' ? (row.operation === 'upsert' ? row.data as Row | undefined : undefined) : row;
  if (!target) return false;
  return typeof target._enc !== 'string' || 'fieldTimestamps' in target;
}

/**
 * Once, at the first unlock after an update (LocalSettings.atRestRewrittenAt):
 * rewrite every stored row that needsRewrite. It runs inside the unlock, before
 * the app is shown, so nothing can edit a row between the read and the write;
 * the crypto happens outside any transaction (Safari). A row the key cannot open
 * is left as it is. Returns how many rows were rewritten.
 */
export async function rewriteLegacyAtRestRows(key: CryptoKey): Promise<number> {
  let rewritten = 0;
  for (const table of encryptedTables()) {
    setMigrationBypass(true);
    let rows: Row[];
    try {
      rows = (await table.toArray()) as Row[];
    } finally {
      setMigrationBypass(false);
    }
    const fixed: Row[] = [];
    for (const row of rows.filter((r) => needsRewrite(table.name, r))) {
      try {
        const plain = await decryptRow(table.name, key, row);
        fixed.push((await encryptRow(table.name, key, plain)) as Row);
      } catch (err) {
        recordError('vault.atRestRewrite', err);
      }
    }
    if (fixed.length === 0) continue;
    setMigrationBypass(true);
    try {
      await table.bulkPut(fixed as unknown[]);
    } finally {
      setMigrationBypass(false);
    }
    rewritten += fixed.length;
  }
  return rewritten;
}
