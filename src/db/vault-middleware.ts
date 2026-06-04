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

// Dexie table name -> entity type understood by SENSITIVE_FIELDS in crypto.ts.
const ENTITY_TYPE_BY_TABLE: Record<string, string> = {
  tasks: 'task',
  subtasks: 'subtask',
  taskLists: 'taskList',
};

function isHandledTable(name: string): boolean {
  return name === 'changeLog' || name in ENTITY_TYPE_BY_TABLE;
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

type Row = Record<string, unknown>;

async function encryptRow(table: string, key: CryptoKey, row: Row | null | undefined): Promise<Row | null | undefined> {
  if (row == null) return row;

  if (table === 'changeLog') {
    if (row.operation !== 'upsert' || row.data == null) return row;
    const data = row.data as Row;
    if (data._enc) throw new Error('vault-middleware: changeLog.data already carries _enc (double encryption)');
    const encData = await encryptEntity(key, data, String(row.entityType));
    return { ...row, data: encData };
  }

  const entityType = ENTITY_TYPE_BY_TABLE[table];
  if (!entityType) return row;
  if (row._enc) throw new Error(`vault-middleware: ${table} row already carries _enc (double encryption)`);
  return encryptEntity(key, row, entityType);
}

async function decryptRow(table: string, key: CryptoKey, row: Row | null | undefined): Promise<Row | null | undefined> {
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

          async mutate(req) {
            const key = getActiveAtRestKey();
            if (key && (req.type === 'add' || req.type === 'put') && req.values) {
              // crypto.subtle is async; the write must still run inside req.trans
              // afterwards. Dexie.waitFor keeps the IndexedDB transaction alive
              // across the await (a bare await would let it auto-commit -> the
              // downstream mutate would throw InvalidStateError).
              const values = await Dexie.waitFor(
                Promise.all((req.values as Row[]).map((v) => encryptRow(tableName, key, v))),
              );
              return downTable.mutate({ ...req, values: values as typeof req.values });
            }
            return downTable.mutate(req);
          },

          // Decrypt awaits are wrapped in Dexie.waitFor so the IndexedDB
          // transaction stays alive when a read is part of a read-modify-write
          // (e.g. Collection.modify does getMany -> ... -> put in one trans).
          // For pure reads it is harmless.

          async get(req) {
            const row = await downTable.get(req);
            const key = getActiveAtRestKey();
            if (!key) return row;
            return (await Dexie.waitFor(decryptRow(tableName, key, row as Row))) as typeof row;
          },

          async getMany(req) {
            const rows = await downTable.getMany(req);
            const key = getActiveAtRestKey();
            if (!key) return rows;
            return (await Dexie.waitFor(
              Promise.all((rows as Row[]).map((r) => decryptRow(tableName, key, r))),
            )) as typeof rows;
          },

          async query(req) {
            const res = await downTable.query(req);
            const key = getActiveAtRestKey();
            if (!key || req.values === false) return res;
            const result = await Dexie.waitFor(
              Promise.all((res.result as Row[]).map((r) => decryptRow(tableName, key, r))),
            );
            return { ...res, result: result as typeof res.result };
          },

          async openCursor(req) {
            const key = getActiveAtRestKey();
            if (!key || req.values === false) return downTable.openCursor(req);

            const real = await downTable.openCursor(req);
            if (!real) return null;

            const buffer: BufferedEntry[] = [];
            await real.start(() => {
              buffer.push({ key: real.key, primaryKey: real.primaryKey, value: real.value });
              real.continue();
            });

            const decrypted = await Dexie.waitFor(
              Promise.all(buffer.map((e) => decryptRow(tableName, key, e.value as Row))),
            );
            buffer.forEach((e, idx) => { e.value = decrypted[idx]; });

            return makeBufferedCursor(buffer, req.trans) as unknown as Awaited<ReturnType<typeof downTable.openCursor>>;
          },
        };
      },
    };
  },
};
