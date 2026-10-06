import { vi } from 'vitest';
import { db, ensureDefaults } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { SYNC_VERSION } from '../../sync/version';

// Reliability review 2026-10-06 (B14): startup housekeeping ran as one chain —
// a step that threw (storage full, a timeout, a data bug) skipped every step
// after it on every start, the local data migrations (last) included.

beforeEach(async () => {
  await resetDb();
});
afterEach(() => vi.restoreAllMocks());

it('one failing step does not stop the others — the migrations least of all', async () => {
  await db.localSettings.update('local', { appliedSyncVersion: SYNC_VERSION - 1 });
  // The orphan repair (the first step) fails this time.
  vi.spyOn(db.taskLists, 'toArray').mockRejectedValueOnce(new Error('disk hiccup'));

  await expect(ensureDefaults()).resolves.toBeUndefined();

  expect((await db.localSettings.get('local'))?.appliedSyncVersion).toBe(SYNC_VERSION);
});
