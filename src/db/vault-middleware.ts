// At-rest encryption middleware (Paranoid Mode).
//
// A single async DBCore middleware is the ONE chokepoint that encrypts the
// sensitive fields of `tasks` / `subtasks` / `taskLists` (and the nested
// `changeLog.data` snapshots) before they hit IndexedDB, and decrypts them on
// the way out. Because it lives at the DBCore layer, every read/write path —
// add / bulkPut / partial update / get / getMany / toArray / where / filter /
// liveQuery — is covered without touching call sites. A missed call site (the
// failure mode of a per-site wrapper) is therefore impossible.
//
// Key facts that make this safe:
//   - DBCore mutate/query/get/getMany/openCursor return Promises, so we can
//     await crypto.subtle (unlike the legacy synchronous `hook('reading')`).
//   - Dexie lowers Table.update()/Collection.modify() to getMany -> modify the
//     decrypted clone -> put(full value) through this same core, so partial
//     updates of an encrypted field round-trip for free.
//   - The bottom IDB core writes the full `values` and ignores criteria/
//     changeSpec, so encrypting `values` on add/put is sufficient.
//
// The key is provided lazily via setVaultKeyProvider(). When it returns null
// (Paranoid Mode off, or vault locked) the middleware is a transparent
// pass-through — zero behavior change. setMigrationBypass(true) forces
// pass-through even while a key is set; the disable migration uses it to write
// plaintext back to disk.

import Dexie, { type Middleware, type DBCore, type DBCoreTable } from 'dexie';
import { encryptEntity, decryptEntity } from '../sync/crypto';
import { recordError } from '../lib/diagnostics';

// Dexie table name -> entity type understood by SENSITIVE_FIELDS in crypto.ts.
const ENTITY_TYPE_BY_TABLE: Record<string, string> = {
  tasks: 'task',
  subtasks: 'subtask',
  taskLists: 'taskList',
  sharedItems: 'sharedItem',
  mindmapFolders: 'mindmapFolder',
  mindmaps: 'mindmap',
  mindmapNodes: 'mindmapNode',
};

function isHandledTable(name: string): boolean {
  return name === 'changeLog' || name in ENTITY_TYPE_BY_TABLE;
}

function needsEncryption(table: string, row: Row): boolean {
  if (table === 'changeLog') {
    if (row.operation !== 'upsert' || row.data == null) return false;
    return !(row.data as Row)._enc;
  }
  return !!ENTITY_TYPE_BY_TABLE[table] && !row._enc;
}

// --- Key provider + migration bypass ---

let keyProvider: () => CryptoKey | null = () => null;
let migrationBypass = false;

/** Wire up the source of the at-rest DEK (set by the vault module). */
export function setVaultKeyProvider(fn: () => CryptoKey | null): void {
  keyProvider = fn;
}

/** Reset to the default no-key provider (e.g. on teardown/tests). */
export function clearVaultKeyProvider(): void {
  keyProvider = () => null;
}

/** When true, the middleware passes through even if a key is set. */
export function setMigrationBypass(on: boolean): void {
  migrationBypass = on;
}

/** The key actually in effect for at-rest crypto right now (null = passthrough). */
export function getActiveAtRestKey(): CryptoKey | null {
  return migrationBypass ? null : keyProvider();
}

// --- Row transforms ---

export type Row = Record<string, unknown>;

// Exported so the enable/disable migration can run these transforms IN MEMORY
// (outside any IndexedDB transaction) and write the results with the middleware
// bypassed — keeping crypto.subtle out of the write transaction, which Safari's
// IndexedDB requires (it auto-commits during an in-transaction crypto await).
export async function encryptRow(table: string, key: CryptoKey, row: Row | null | undefined): Promise<Row | null | undefined> {
  if (row == null) return row;

  if (table === 'changeLog') {
    if (row.operation !== 'upsert' || row.data == null) return row;
    const data = row.data as Row;
    // Already at-rest encrypted -> pass through (no double-encryption). This lets
    // the enable migration write rows it encrypted IN MEMORY through the normal
    // write path, so it needs no global read/write bypass (whose window made
    // concurrent liveQuery reads return raw `_enc` -> e.g. blank list names).
    if (data._enc) return row;
    const encData = await encryptEntity(key, data, String(row.entityType));
    return { ...row, data: encData };
  }

  const entityType = ENTITY_TYPE_BY_TABLE[table];
  if (!entityType) return row;
  if (row._enc) return row; // already at-rest encrypted -> pass through (see above)
  return encryptEntity(key, row, entityType);
}

export async function decryptRow(table: string, key: CryptoKey, row: Row | null | undefined): Promise<Row | null | undefined> {
  if (row == null) return row;

  if (table === 'changeLog') {
    const data = row.data as Row | undefined;
    if (!data || !data._enc) return row;
    const decData = await decryptEntity(key, data, String(row.entityType));
    return { ...row, data: decData };
  }

  const entityType = ENTITY_TYPE_BY_TABLE[table];
  if (!entityType) return row;
  if (!row._enc) return row; // already plaintext (e.g. mid-migration)
  return decryptEntity(key, row, entityType);
}

// Placeholder shown for a sensitive field whose row could not be decrypted.
const UNREADABLE = '⚠︎ unreadable';

// Build a safe, readable stand-in for a row that failed to decrypt, so a single
// corrupted row cannot make the whole table (or app) unreadable. Metadata
// (id/status/order/…) is intact; the row stays recoverable by re-syncing the
// authoritative copy from remote, which overwrites the corrupt local row.
function quarantineRow(table: string, row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (k !== '_enc') out[k] = v;
  if (table === 'tasks' || table === 'subtasks') out.title = UNREADABLE;
  else if (table === 'taskLists' || table === 'sharedItems') out.name = UNREADABLE;
  out._decryptError = true;
  return out;
}

// Read-path decrypt that never throws: on failure it records the error and
// returns a quarantined placeholder. Used ONLY for reads — the migration path
// stays strict so it never silently destroys recoverable data.
async function safeDecryptRow(table: string, key: CryptoKey, row: Row | null | undefined): Promise<Row | null | undefined> {
  if (row == null) return row;
  try {
    return await decryptRow(table, key, row);
  } catch (err) {
    recordError(`vault-decrypt:${table}`, err);
    return quarantineRow(table, row);
  }
}

// --- Buffered decrypting cursor ---
//
// IndexedDB cursors expose `.value` synchronously, so we cannot decrypt inside a
// `.value` getter. Instead we fully drive the real (encrypted) cursor to buffer
// {key, primaryKey, value} in iteration order, decrypt the values in memory, and
// replay them through a synthetic cursor that honors Dexie's
// start/continue/advance/stop protocol.

interface BufferedEntry { key: unknown; primaryKey: unknown; value: unknown }

interface MinimalCursor {
  trans: unknown;
  done: boolean;
  value: unknown;
  key: unknown;
  primaryKey: unknown;
  start(onEach: () => void): Promise<unknown>;
  continue(target?: unknown): void;
  continuePrimaryKey(target: unknown, targetPk: unknown): void;
  advance(count: number): void;
  stop(value?: unknown): void;
  fail(err: unknown): void;
  next(): Promise<MinimalCursor>;
}

function makeBufferedCursor(buffer: BufferedEntry[], trans: unknown): MinimalCursor {
  let i = 0;
  let stopped = false;
  let stopValue: unknown;
  let failure: unknown;
  let advanced = false;

  const cursor: MinimalCursor = {
    trans,
    done: false,
    value: undefined,
    key: undefined,
    primaryKey: undefined,
    continue(target?: unknown) {
      advanced = true;
      i += 1;
      if (target !== undefined) {
        while (i < buffer.length && (indexedDB.cmp(buffer[i].key as IDBValidKey, target as IDBValidKey) < 0)) i += 1;
      }
    },
    continuePrimaryKey(target: unknown, targetPk: unknown) {
      advanced = true;
      i += 1;
      while (i < buffer.length) {
        const c = indexedDB.cmp(buffer[i].key as IDBValidKey, target as IDBValidKey);
        if (c > 0 || (c === 0 && indexedDB.cmp(buffer[i].primaryKey as IDBValidKey, targetPk as IDBValidKey) >= 0)) break;
        i += 1;
      }
    },
    advance(count: number) {
      advanced = true;
      i += Math.max(1, count);
    },
    stop(value?: unknown) {
      stopped = true;
      stopValue = value;
    },
    fail(err: unknown) {
      failure = err;
    },
    start(onEach: () => void) {
      return new Promise((resolve, reject) => {
        // Synchronous pump over the in-memory buffer (no IDB involved).
        for (;;) {
          if (failure !== undefined) return reject(failure);
          if (stopped) return resolve(stopValue);
          if (i >= buffer.length) {
            cursor.done = true;
            return resolve(undefined);
          }
          const entry = buffer[i];
          cursor.value = entry.value;
          cursor.key = entry.key;
          cursor.primaryKey = entry.primaryKey;
          advanced = false;
          onEach();
          if (failure !== undefined) return reject(failure);
          if (stopped) return resolve(stopValue);
          if (!advanced) i += 1; // safety against a non-advancing consumer
        }
      });
    },
    next() {
      let gotOne = 1;
      return cursor.start(() => {
        if (gotOne-- > 0) cursor.continue();
        else cursor.stop();
      }).then(() => cursor);
    },
  };

  return cursor;
}

// --- Middleware ---

export const vaultMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'vault-at-rest',
  create(downCore) {
    return {
      ...downCore,
      table(tableName: string): DBCoreTable {
        const downTable = downCore.table(tableName);
        if (!isHandledTable(tableName)) return downTable;

        return {
          ...downTable,

          // CRITICAL: every method wraps BOTH the IDB call and the crypto in a
          // single Dexie.waitFor. waitFor begins pinging the transaction
          // synchronously (the moment it is called), so the transaction stays
          // alive across the dangerous window *right after* an IDB read resolves
          // — before the crypto await — where real IndexedDB would otherwise
          // auto-commit. (Starting waitFor only around the crypto, after already
          // awaiting the IDB call, leaves that window open: fake-indexeddb
          // tolerates it, real IndexedDB throws "transaction has finished".)

          async mutate(req) {
            const key = getActiveAtRestKey();
            if (key && (req.type === 'add' || req.type === 'put') && req.values) {
              const rows = req.values as Row[];
              if (!rows.some((v) => needsEncryption(tableName, v))) return downTable.mutate(req);
              return Dexie.waitFor((async () => {
                const values = await Promise.all(rows.map((v) => encryptRow(tableName, key, v)));
                return downTable.mutate({ ...req, values: values as typeof req.values });
              })());
            }
            return downTable.mutate(req);
          },

          async get(req) {
            const key = getActiveAtRestKey();
            if (!key) return downTable.get(req);
            return Dexie.waitFor((async () => {
              const row = await downTable.get(req);
              return (await safeDecryptRow(tableName, key, row as Row)) as typeof row;
            })());
          },

          async getMany(req) {
            const key = getActiveAtRestKey();
            if (!key) return downTable.getMany(req);
            return Dexie.waitFor((async () => {
              const rows = await downTable.getMany(req);
              return (await Promise.all((rows as Row[]).map((r) => safeDecryptRow(tableName, key, r)))) as typeof rows;
            })());
          },

          async query(req) {
            const key = getActiveAtRestKey();
            if (!key || req.values === false) return downTable.query(req);
            return Dexie.waitFor((async () => {
              const res = await downTable.query(req);
              const result = await Promise.all((res.result as Row[]).map((r) => safeDecryptRow(tableName, key, r)));
              return { ...res, result: result as typeof res.result };
            })());
          },

          async openCursor(req) {
            const key = getActiveAtRestKey();
            if (!key || req.values === false) return downTable.openCursor(req);
            return Dexie.waitFor((async () => {
              const real = await downTable.openCursor(req);
              if (!real) return null;

              const buffer: BufferedEntry[] = [];
              await real.start(() => {
                buffer.push({ key: real.key, primaryKey: real.primaryKey, value: real.value });
                real.continue();
              });

              const decrypted = await Promise.all(buffer.map((e) => safeDecryptRow(tableName, key, e.value as Row)));
              buffer.forEach((e, idx) => { e.value = decrypted[idx]; });

              return makeBufferedCursor(buffer, req.trans) as unknown as Awaited<ReturnType<typeof downTable.openCursor>>;
            })());
          },
        };
      },
    };
  },
};
