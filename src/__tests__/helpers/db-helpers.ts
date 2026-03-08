import { db, ensureDefaults } from '../../db/index.ts';

export async function resetDb() {
  await db.delete();
  await db.open();
  await ensureDefaults();
}
