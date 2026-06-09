import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { makeSharedItem, makeChangeEntry } from '../helpers/sync-helpers';
import { applyRemoteEntries } from '../../sync/change-log';
import { getLocalSnapshot } from '../../sync/sync-engine';

beforeEach(async () => {
  await resetDb();
});

describe('shared item sync (applyRemoteEntries + snapshot)', () => {
  it('applies a remote sharedItem upsert into db.sharedItems', async () => {
    const item = makeSharedItem({ id: 's1', name: 'Remote link' });
    await applyRemoteEntries([
      makeChangeEntry({
        entityType: 'sharedItem',
        entityId: 's1',
        operation: 'upsert',
        data: item as unknown as Record<string, unknown>,
      }),
    ]);

    const stored = await db.sharedItems.get('s1');
    expect(stored).toBeDefined();
    expect(stored?.name).toBe('Remote link');
  });

  it('applies a remote delete as a soft-delete', async () => {
    await db.sharedItems.add(makeSharedItem({ id: 's2', updatedAt: 1000 }));
    await applyRemoteEntries([
      makeChangeEntry({
        entityType: 'sharedItem',
        entityId: 's2',
        operation: 'delete',
        timestamp: 2000,
        data: undefined,
      }),
    ]);

    const stored = await db.sharedItems.get('s2');
    expect(stored?.deletedAt).toBe(2000);
  });

  it('includes sharedItems in the local snapshot', async () => {
    await db.sharedItems.add(makeSharedItem({ id: 's3', name: 'In snapshot' }));
    const snap = await getLocalSnapshot();
    expect(snap.sharedItems?.some((i) => i.id === 's3')).toBe(true);
  });
});
