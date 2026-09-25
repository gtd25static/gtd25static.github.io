import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  createLinkItem,
  createFileItem,
  createSnippetItem,
  deleteSharedItem,
  deleteAllSharedItems,
} from '../../hooks/use-shared-items';
import { makeSharedItem } from '../helpers/sync-helpers';
import { MAX_SHARED_FOLDER_BYTES } from '../../lib/constants';
import { sharedBlobBlocker, uploadSharedBlob } from '../../sync/shared-blobs';
import { toast } from '../../components/ui/Toast';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/shared-blobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/shared-blobs')>()),
  sharedBlobBlocker: vi.fn(async () => 'no-sync'),
  uploadSharedBlob: vi.fn(async () => {}),
}));

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

// Files and snippets live in the sync repository; without sync the upload
// failed with "Failed to add shared file. Please try again."
describe('adding a file or snippet without sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says sync is needed, and stores nothing', async () => {
    vi.mocked(sharedBlobBlocker).mockResolvedValue('no-sync');
    expect(await createSnippetItem('Note', 'some text')).toBeUndefined();
    expect(await createFileItem(new File([new Uint8Array(10)], 'a.bin'))).toBeUndefined();

    expect(uploadSharedBlob).not.toHaveBeenCalled();
    expect(await db.sharedItems.count()).toBe(0);
    const messages = vi.mocked(toast).mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toMatch(/set up sync/i);
      expect(message).not.toMatch(/try again/i);
    }
  });

  it('says to wait when sync is set up but still starting', async () => {
    vi.mocked(sharedBlobBlocker).mockResolvedValue('not-ready');
    expect(await createSnippetItem('Note', 'some text')).toBeUndefined();
    expect(uploadSharedBlob).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast).mock.calls[0][0])).toMatch(/still starting/);
  });

  it('still adds links, which need no upload', async () => {
    vi.mocked(sharedBlobBlocker).mockResolvedValue('no-sync');
    expect(await createLinkItem('https://example.com')).toBeDefined();
  });
});

// "Item is 30.0 MB but only 30.0 MB is free": both rounded to the nearest
// 0.1 MB. The size is rounded up and the free space down, so they differ.
describe('the quota message', () => {
  it('never shows the item and the free space as the same number', async () => {
    vi.mocked(sharedBlobBlocker).mockResolvedValue(null);
    await db.sharedItems.add(makeSharedItem({ size: 1000 }));
    const file = new File([new Uint8Array(MAX_SHARED_FOLDER_BYTES - 500)], 'big.bin');

    expect(await createFileItem(file)).toBeUndefined();

    const message = String(vi.mocked(toast).mock.calls.at(-1)?.[0]);
    const [item, free] = [...message.matchAll(/([\d.]+) MB/g)].map((m) => m[1]);
    expect(item).toBeDefined();
    expect(free).toBeDefined();
    expect(item).not.toBe(free);
    expect(Number(item)).toBeGreaterThan(Number(free));
  });
});
