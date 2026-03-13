import { db, ensureDefaults } from '../../db/index.ts';
import { clearDeviceIdCache } from '../../sync/change-log';

export async function resetDb() {
  clearDeviceIdCache();
  await db.delete();
  await db.open();
  await ensureDefaults();
}

export function assertDefined<T>(value: T | undefined, label = 'value'): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}
