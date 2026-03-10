import { db, ensureDefaults } from '../../db/index.ts';
import { clearDeviceIdCache } from '../../sync/change-log';

export async function resetDb() {
  clearDeviceIdCache();
  await db.delete();
  await db.open();
  await ensureDefaults();
}
