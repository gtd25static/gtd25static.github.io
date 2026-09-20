import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  createLinkItem,
  createSnippetItem,
  deleteSharedItem,
  deleteAllSharedItems,
} from '../../hooks/use-shared-items';
import { makeSharedItem } from '../helpers/sync-helpers';
import { MAX_SHARED_FOLDER_BYTES } from '../../lib/constants';

beforeEach(async () => {
  await resetDb();
});

describe('createLinkItem', () => {
  it('creates a link item and records a sharedItem change', async () => {
    const item = await createLinkItem('https://example.com', 'Example');
    expect(item).toBeDefined();
    expect(item!.type).toBe('link');
    expect(item!.url).toBe('https://example.com');
    expect(item!.size).toBeGreaterThan(0);

    const stored = await db.sharedItems.get(item!.id);
    expect(stored?.url).toBe('https://example.com');

    const changes = (await db.changeLog.toArray()).filter((c) => c.entityType === 'sharedItem');
    expect(changes.length).toBe(1);
    expect(changes[0].entityId).toBe(item!.id);
  });

  it('rejects an invalid URL', async () => {
    const item = await createLinkItem('not a url');
    expect(item).toBeUndefined();
    expect(await db.sharedItems.count()).toBe(0);
  });

  it('rejects an item that exceeds the remaining quota', async () => {
    // Pre-seed an item that fills the whole folder.
    await db.sharedItems.add(makeSharedItem({ size: MAX_SHARED_FOLDER_BYTES }));
    const before = await db.sharedItems.count();

    const item = await createLinkItem('https://too-big.example.com');
    expect(item).toBeUndefined();
    expect(await db.sharedItems.count()).toBe(before);
  });
});

describe('createSnippetItem', () => {
  it('rejects empty text', async () => {
    const item = await createSnippetItem('notes', '   ');
    expect(item).toBeUndefined();
    expect(await db.sharedItems.count()).toBe(0);
  });
});

describe('deleteSharedItem', () => {
  it('soft-deletes and frees quota (excluded from active items)', async () => {
    const item = await createLinkItem('https://example.com', 'Example');
    expect(item).toBeDefined();

    await deleteSharedItem(item!.id);

    const stored = await db.sharedItems.get(item!.id);
    expect(stored?.deletedAt).toBeGreaterThan(0);

    const active = (await db.sharedItems.toArray()).filter((i) => !i.deletedAt);
    expect(active.length).toBe(0);

    // A delete tombstone change is recorded for sync.
    const changes = (await db.changeLog.toArray()).filter((c) => c.entityType === 'sharedItem');
    expect(changes.some((c) => c.entityId === item!.id)).toBe(true);
  });
});

describe('deleteAllSharedItems', () => {
  it('soft-deletes every live item and records a tombstone for each', async () => {
    const a = await createLinkItem('https://a.example.com', 'A');
    const b = await createLinkItem('https://b.example.com', 'B');
    const c = await createLinkItem('https://c.example.com', 'C');

    const deleted = await deleteAllSharedItems();
    expect(deleted).toBe(3);

    const rows = await db.sharedItems.toArray();
    expect(rows.length).toBe(3); // tombstones stay for sync
    expect(rows.every((i) => (i.deletedAt ?? 0) > 0)).toBe(true);

    const changes = (await db.changeLog.toArray()).filter((c2) => c2.entityType === 'sharedItem');
    for (const id of [a!.id, b!.id, c!.id]) {
      expect(changes.filter((c2) => c2.entityId === id).length).toBe(2); // create + delete
    }
  });

  it('leaves already-deleted items alone and reports 0 on an empty folder', async () => {
    const keep = await createLinkItem('https://keep.example.com', 'Keep');
    await deleteSharedItem(keep!.id);
    const stampedAt = (await db.sharedItems.get(keep!.id))!.deletedAt;

    expect(await deleteAllSharedItems()).toBe(0);
    expect((await db.sharedItems.get(keep!.id))!.deletedAt).toBe(stampedAt);
  });
});
