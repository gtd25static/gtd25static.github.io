import type { DBCore, Middleware } from 'dexie';

// Tasks and subtasks flag a warning with `hasWarning`, which Attention finds
// through the `hasWarning` index. IndexedDB can't index booleans, so rows written
// with `true` never reached that index and Attention missed every warning. The
// flag is stored as 1; rows arriving as `true` (sync from an older build or
// device, snapshots, imports) are normalised on their way to disk. The field is
// not encrypted at rest, so this holds in Paranoid Mode too.

type Row = Record<string, unknown> | null | undefined;

const normalise = (row: Row): Row => (row && row.hasWarning === true ? { ...row, hasWarning: 1 } : row);

export const warningIndexMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'warning-index',
  create(downCore) {
    return {
      ...downCore,
      table(tableName: string) {
        const downTable = downCore.table(tableName);
        if (tableName !== 'tasks' && tableName !== 'subtasks') return downTable;
        return {
          ...downTable,
          mutate(req) {
            if ((req.type === 'add' || req.type === 'put') && (req.values as Row[]).some((v) => v?.hasWarning === true)) {
              return downTable.mutate({ ...req, values: (req.values as Row[]).map(normalise) as typeof req.values });
            }
            return downTable.mutate(req);
          },
        };
      },
    };
  },
};

/**
 * One-time schema upgrade: rewrite `hasWarning: true` as 1 in a raw object store.
 * Runs on the raw IndexedDB store, below the at-rest middleware, because the
 * upgrade happens before any unlock: going through the middleware would refuse
 * the plaintext rows an interrupted Paranoid enable can leave behind, abort the
 * upgrade, and leave the database unopenable. Only the plaintext flag changes.
 */
export function normaliseWarningsInStore(store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      const value = cursor.value as Record<string, unknown>;
      if (value.hasWarning === true) cursor.update({ ...value, hasWarning: 1 });
      cursor.continue();
    };
  });
}
