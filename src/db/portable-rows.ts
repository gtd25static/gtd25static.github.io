import { withoutLocalSyncFields } from '../sync/field-timestamps';

/**
 * Rows as they leave this device in an export or a safety copy: never the
 * placeholder the vault shows for a row it could not decrypt (`_decryptError`) —
 * written back by an import or a restore, it replaced the intact copies on the
 * remote and every other device — and without this device's sync bookkeeping
 * (`_base` / `_pushed`). Also counts the rows left out.
 */
export function portableRows<T>(rows: T[]): { rows: T[]; unreadable: number } {
  const readable = rows.filter((row) => !(row as { _decryptError?: boolean })._decryptError);
  return { rows: readable.map((row) => withoutLocalSyncFields(row)), unreadable: rows.length - readable.length };
}
