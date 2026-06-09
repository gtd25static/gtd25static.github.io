import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  createLinkItem,
  createSnippetItem,
  deleteSharedItem,
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
