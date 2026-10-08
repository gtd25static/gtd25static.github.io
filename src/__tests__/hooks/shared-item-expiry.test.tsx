// @vitest-environment jsdom
// What a device in Paranoid Mode adds to the Shared Folder (file, snippet or
// link) is deleted 24 h after it was added — on whichever unlocked device sees
// it expired first, bytes included — and its card says when. The expiry is
// encrypted like the item's other fields: in the clear it would say which
// device runs Paranoid Mode.
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { makeSharedItem } from '../helpers/sync-helpers';
import {
  createLinkItem,
  createFileItem,
  createSnippetItem,
  expireSharedItems,
  sharedItemExpiry,
  useSharedItemExpiry,
} from '../../hooks/use-shared-items';
import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import { PARANOID_SHARED_ITEM_TTL_MS } from '../../lib/constants';
import { encryptEntity, decryptEntity, SENSITIVE_FIELDS } from '../../sync/crypto';
import { runRemoteMigrations } from '../../sync/migrations';
import { placeholderRow } from '../../lib/placeholder-content';
import { enableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { SharedItem, SyncData } from '../../db/models';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/shared-blobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/shared-blobs')>()),
  sharedBlobBlocker: vi.fn(async () => null),
  uploadSharedBlob: vi.fn(async () => {}),
}));

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

const stored = async (id: string) => db.sharedItems.get(id);

describe('a new item', () => {
  it('outside Paranoid Mode never expires', async () => {
    const item = await createLinkItem('https://example.com', 'Example');
    expect(item?.expiresAt).toBeUndefined();
    expect((await stored(item!.id))?.expiresAt).toBeUndefined();
  });

  it('from a device in Paranoid Mode expires 24 h after it was added — link, snippet and file alike', async () => {
    await enableParanoid('shared expiry passphrase 7 harbour');
    const link = await createLinkItem('https://example.com', 'Example');
    const snippet = await createSnippetItem('notes', 'some text');
    const file = await createFileItem(new File(['bytes'], 'a.txt', { type: 'text/plain' }));

    for (const item of [link, snippet, file]) {
      expect(item).toBeDefined();
      expect(item!.expiresAt).toBe(item!.createdAt + PARANOID_SHARED_ITEM_TTL_MS);
      expect((await stored(item!.id))?.expiresAt).toBe(item!.expiresAt);
    }
    expect(PARANOID_SHARED_ITEM_TTL_MS).toBe(24 * HOUR);
  });

  it('carries its expiry in the change that syncs it', async () => {
    await enableParanoid('shared expiry passphrase 7 harbour');
    const item = await createLinkItem('https://example.com', 'Example');
    const change = (await db.changeLog.toArray()).find((c) => c.entityId === item!.id);
    expect(change?.data?.expiresAt).toBe(item!.expiresAt);
  });
});

describe('sharedItemExpiry (synced data, untrusted)', () => {
  it('a positive finite number is the expiry', () => {
    expect(sharedItemExpiry(makeSharedItem({ expiresAt: 1234 }))).toBe(1234);
  });

  it.each([
    ['absent', undefined],
    ['a string', '1234'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -5],
    ['null', null],
  ])('%s is no expiry', (_label, value) => {
    expect(sharedItemExpiry(makeSharedItem({ expiresAt: value as unknown as number }))).toBeUndefined();
  });
});

describe('expireSharedItems', () => {
  it('deletes the expired items only — tombstone, change for sync and local bytes', async () => {
    const now = Date.now();
    const expired = makeSharedItem({ type: 'file', blobId: 'blob-expired', expiresAt: now - 1 });
    const later = makeSharedItem({ expiresAt: now + HOUR });
    const forever = makeSharedItem();
    const alreadyGone = makeSharedItem({ expiresAt: now - HOUR, deletedAt: now - 10, updatedAt: now - 10 });
    await db.sharedItems.bulkAdd([expired, later, forever, alreadyGone]);
    await db.sharedBlobs.put({ id: 'blob-expired' } as never);

    expect(await expireSharedItems(now)).toBe(1);

    expect((await stored(expired.id))?.deletedAt).toBeGreaterThan(0);
    expect((await stored(later.id))?.deletedAt).toBeUndefined();
    expect((await stored(forever.id))?.deletedAt).toBeUndefined();
    expect((await stored(alreadyGone.id))?.deletedAt).toBe(now - 10);
    expect(await db.sharedBlobs.get('blob-expired')).toBeUndefined();
    const changes = (await db.changeLog.toArray()).filter((c) => c.entityType === 'sharedItem');
    expect(changes.map((c) => c.entityId)).toEqual([expired.id]);
  });

  it('an item exactly at its expiry goes', async () => {
    const now = Date.now();
    const item = makeSharedItem({ expiresAt: now });
    await db.sharedItems.add(item);
    expect(await expireSharedItems(now)).toBe(1);
  });

  it('nothing expired: nothing written', async () => {
    await db.sharedItems.add(makeSharedItem({ expiresAt: Date.now() + HOUR }));
    expect(await expireSharedItems()).toBe(0);
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('useSharedItemExpiry', () => {
  it('deletes an item already expired when the app opens', async () => {
    const item = makeSharedItem({ expiresAt: Date.now() - HOUR });
    await db.sharedItems.add(item);
    renderHook(() => useSharedItemExpiry());
    await waitFor(async () => expect((await stored(item.id))?.deletedAt).toBeGreaterThan(0));
  });

  it('deletes an item when its time comes, with the app open', async () => {
    const item = makeSharedItem({ expiresAt: Date.now() + 400 });
    await db.sharedItems.add(item);
    renderHook(() => useSharedItemExpiry());
    // Not before its time...
    await new Promise((r) => setTimeout(r, 100));
    expect((await stored(item.id))?.deletedAt).toBeUndefined();
    // ...but right after.
    await waitFor(async () => expect((await stored(item.id))?.deletedAt).toBeGreaterThan(0), { timeout: 3000 });
  });

  it('deletes an expired item that sync brings in from another device', async () => {
    renderHook(() => useSharedItemExpiry());
    await new Promise((r) => setTimeout(r, 50));
    const item = makeSharedItem({ expiresAt: Date.now() - 1 });
    await db.sharedItems.add(item);
    await waitFor(async () => expect((await stored(item.id))?.deletedAt).toBeGreaterThan(0));
  });

  it('after a sleep that froze its timer, deletes the item when the app is back in view', async () => {
    const start = Date.now();
    const item = makeSharedItem({ expiresAt: start + HOUR });
    await db.sharedItems.add(item);
    vi.useFakeTimers({ toFake: ['Date'] }); // only the wall clock moves: the timer stays an hour out
    try {
      renderHook(() => useSharedItemExpiry());
      await new Promise((r) => setTimeout(r, 50));
      vi.setSystemTime(start + 2 * HOUR);
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(async () => expect((await stored(item.id))?.deletedAt).toBeGreaterThan(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves items without an expiry alone', async () => {
    const item = makeSharedItem();
    await db.sharedItems.add(item);
    renderHook(() => useSharedItemExpiry());
    await new Promise((r) => setTimeout(r, 100));
    expect((await stored(item.id))?.deletedAt).toBeUndefined();
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('the card', () => {
  const card = (over: Partial<SharedItem>) => render(<SharedItemCard item={makeSharedItem({ name: 'Example', ...over })} />);

  it('says nothing for an item that never expires', () => {
    card({});
    expect(screen.queryByText(/Deletes in/)).toBeNull();
  });

  it('counts down the hours left', () => {
    card({ expiresAt: Date.now() + 23.5 * HOUR });
    expect(screen.getByText('Deletes in 23h')).toBeInTheDocument();
  });

  it('counts the minutes in the last hour', () => {
    card({ expiresAt: Date.now() + 42 * 60_000 - 1000 });
    expect(screen.getByText('Deletes in 42m')).toBeInTheDocument();
  });

  it('past its time, while the delete runs', () => {
    card({ expiresAt: Date.now() - 1000 });
    expect(screen.getByText('Deleting…')).toBeInTheDocument();
  });
});

describe('on the wire, at rest and in the decoy', () => {
  it('is encrypted on the wire, and decrypts back', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const row = { ...makeSharedItem({ id: 's1' }), expiresAt: 1_900_000_000_000 };
    const encrypted = await encryptEntity(key, row, 'sharedItem');
    expect(SENSITIVE_FIELDS.sharedItem).toContain('expiresAt');
    expect('expiresAt' in encrypted).toBe(false);
    expect(JSON.stringify(encrypted)).not.toContain('1900000000000');
    expect((await decryptEntity(key, encrypted, 'sharedItem')).expiresAt).toBe(1_900_000_000_000);
  });

  it('is not on disk in the clear under Paranoid Mode', async () => {
    await enableParanoid('shared expiry passphrase 7 harbour');
    const item = await createLinkItem('https://example.com', 'Example');
    const expiry = String(item!.expiresAt);
    setMigrationBypass(true);
    try {
      const raw = await db.sharedItems.get(item!.id);
      expect(raw && 'expiresAt' in raw).toBe(false);
      expect(JSON.stringify(raw)).not.toContain(expiry);
      expect(JSON.stringify(await db.changeLog.toArray())).not.toContain(expiry);
    } finally {
      setMigrationBypass(false);
    }
  });

  it('the decoy keeps it (the item still goes when the real one would have)', () => {
    const row = placeholderRow('sharedItem', { ...makeSharedItem({ id: 's1' }), expiresAt: 1234 });
    expect(row.expiresAt).toBe(1234);
  });

  it('the v11 -> v12 migration rewrites nothing', () => {
    const items = [makeSharedItem({ id: 's1' })];
    const data = { syncVersion: 11, taskLists: [], tasks: [], subtasks: [], sharedItems: items, settings: { theme: 'system' } } as unknown as SyncData;
    const migrated = runRemoteMigrations(data, 11, 12);
    expect(migrated.syncVersion).toBe(12);
    expect(migrated.sharedItems).toBe(items);
  });
});
