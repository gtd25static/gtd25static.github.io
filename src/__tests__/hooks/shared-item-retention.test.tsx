// @vitest-environment jsdom
// Everything in the Shared Folder is deleted 30 days after it was added (12 h
// if from a device in Paranoid Mode: shared-item-expiry.test.tsx), and over its
// last 10 days its card fades into the page. The items already there when the
// rule arrived are not deleted before SHARED_ITEM_RETENTION_GRACE_UNTIL. The
// folder lists the newest first, each card with when it was added.
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { makeSharedItem } from '../helpers/sync-helpers';
import {
  createLinkItem,
  expireSharedItems,
  retentionExpiry,
  sharedItemExpiry,
  sharedItemOpacity,
  useSharedItemExpiry,
  useSharedItems,
} from '../../hooks/use-shared-items';
import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import {
  SHARED_ITEM_FADE_MS,
  SHARED_ITEM_RETENTION_GRACE_UNTIL as GRACE,
  SHARED_ITEM_RETENTION_MS,
} from '../../lib/constants';
import { validateEntityShape } from '../../sync/change-log';
import type { SharedItem } from '../../db/models';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A moment well after the grace, so a fresh item's 30 days are its own.
const LATER = GRACE + 100 * DAY;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

const stored = async (id: string) => db.sharedItems.get(id);

describe('retentionExpiry', () => {
  it('is 30 days after the item was added', () => {
    expect(SHARED_ITEM_RETENTION_MS).toBe(30 * DAY);
    expect(retentionExpiry(makeSharedItem({ createdAt: LATER }))).toBe(LATER + 30 * DAY);
  });

  it('is never before the grace: an item already old when the rule arrived gets its ten days', () => {
    expect(GRACE).toBe(Date.UTC(2026, 10, 7));
    expect(retentionExpiry(makeSharedItem({ createdAt: GRACE - 90 * DAY }))).toBe(GRACE);
    expect(retentionExpiry(makeSharedItem({ createdAt: GRACE - 20 * DAY }))).toBe(GRACE + 10 * DAY);
  });

  it.each([
    ['absent', undefined],
    ['a string', '1234'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -5],
  ])('a createdAt that is %s gives none', (_label, value) => {
    expect(retentionExpiry(makeSharedItem({ createdAt: value as unknown as number }))).toBeUndefined();
  });
});

describe('sharedItemExpiry: the sooner rule wins', () => {
  it('an item added outside Paranoid Mode goes at 30 days', () => {
    expect(sharedItemExpiry(makeSharedItem({ createdAt: LATER }))).toBe(LATER + 30 * DAY);
  });

  it('one added in Paranoid Mode goes at its own expiry', () => {
    expect(sharedItemExpiry(makeSharedItem({ createdAt: LATER, expiresAt: LATER + 12 * HOUR }))).toBe(LATER + 12 * HOUR);
  });

  it('an unreadable createdAt still leaves the Paranoid expiry', () => {
    expect(sharedItemExpiry(makeSharedItem({ createdAt: NaN, expiresAt: 1234 }))).toBe(1234);
    expect(sharedItemExpiry(makeSharedItem({ createdAt: NaN }))).toBeUndefined();
  });
});

describe('expireSharedItems at 30 days', () => {
  it('deletes the item 30 days old, bytes included, and keeps the one 29 days old', async () => {
    const old = makeSharedItem({ type: 'file', blobId: 'blob-old', createdAt: LATER - 30 * DAY });
    const young = makeSharedItem({ createdAt: LATER - 29 * DAY });
    await db.sharedItems.bulkAdd([old, young]);
    await db.sharedBlobs.put({ id: 'blob-old' } as never);

    expect(await expireSharedItems(LATER)).toBe(1);

    expect((await stored(old.id))?.deletedAt).toBeGreaterThan(0);
    expect((await stored(young.id))?.deletedAt).toBeUndefined();
    expect(await db.sharedBlobs.get('blob-old')).toBeUndefined();
    const changes = (await db.changeLog.toArray()).filter((c) => c.entityType === 'sharedItem');
    expect(changes.map((c) => c.entityId)).toEqual([old.id]);
  });

  it('an item months old waits for the grace, then goes', async () => {
    const old = makeSharedItem({ createdAt: GRACE - 90 * DAY });
    await db.sharedItems.add(old);
    expect(await expireSharedItems(GRACE - 1)).toBe(0);
    expect(await expireSharedItems(GRACE)).toBe(1);
  });
});

describe('useSharedItemExpiry and the 30 days', () => {
  it('deletes an item past its 30 days when the app opens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATER);
    const item = makeSharedItem({ createdAt: LATER - 31 * DAY });
    await db.sharedItems.add(item);
    renderHook(() => useSharedItemExpiry());
    await waitFor(async () => expect((await stored(item.id))?.deletedAt).toBeGreaterThan(0));
  });

  it('arms no timer past setTimeout\'s range (a longer one fires at once)', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const item = makeSharedItem(); // added now: due in 30 days
      await db.sharedItems.add(item);
      renderHook(() => useSharedItemExpiry());
      await waitFor(() => expect(spy.mock.calls.some(([, ms]) => ms === 2 ** 31 - 1)).toBe(true));
      expect(spy.mock.calls.every(([, ms]) => (ms ?? 0) <= 2 ** 31 - 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect((await stored(item.id))?.deletedAt).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the folder lists the newest first', () => {
  it('by when each item was added, whatever its order field says', async () => {
    const t = Date.now();
    await db.sharedItems.bulkAdd([
      makeSharedItem({ id: 'middle', createdAt: t - DAY, order: 0 }),
      makeSharedItem({ id: 'newest', createdAt: t, order: 1 }),
      makeSharedItem({ id: 'unreadable', createdAt: 'x' as unknown as number, order: 2 }),
      makeSharedItem({ id: 'oldest', createdAt: t - 2 * DAY, order: 3 }),
      makeSharedItem({ id: 'deleted', createdAt: t + DAY, deletedAt: t }),
    ]);
    const { result } = renderHook(() => useSharedItems());
    await waitFor(() => expect(result.current.map((i) => i.id)).toEqual(['newest', 'middle', 'oldest', 'unreadable']));
  });

  it('a new item still carries an order, unused here: older builds skip a synced item without one', async () => {
    const item = await createLinkItem('https://example.com', 'Example');
    expect(item?.order).toBe(0);
    const change = (await db.changeLog.toArray()).find((c) => c.entityId === item!.id);
    expect(validateEntityShape(change?.data, 'sharedItem')).toBe(true);
  });
});

describe('sharedItemOpacity: the last 10 days fade the card', () => {
  const at = (daysLeft: number) => sharedItemOpacity(makeSharedItem({ createdAt: LATER }), LATER + 30 * DAY - daysLeft * DAY);

  it('fully visible until 10 days are left', () => {
    expect(SHARED_ITEM_FADE_MS).toBe(10 * DAY);
    expect(at(29)).toBe(1);
    expect(at(10)).toBe(1);
  });

  it('then fainter day by day, down to 0.2', () => {
    expect(at(5)).toBeCloseTo(0.6);
    expect(at(1)).toBeCloseTo(0.28);
    expect(at(0)).toBeCloseTo(0.2);
    expect(at(-1)).toBeCloseTo(0.2); // overdue until a device deletes it
    expect(at(9)).toBeGreaterThan(at(8));
  });

  it('an old item fades towards the grace', () => {
    const old = makeSharedItem({ createdAt: GRACE - 90 * DAY });
    expect(sharedItemOpacity(old, GRACE - 5 * DAY)).toBeCloseTo(0.6);
  });

  it('an item added in Paranoid Mode does not fade (its countdown says when)', () => {
    const item = makeSharedItem({ createdAt: LATER, expiresAt: LATER + 12 * HOUR });
    expect(sharedItemOpacity(item, LATER + 11 * HOUR)).toBe(1);
  });

  it('no creation time, no fade', () => {
    expect(sharedItemOpacity(makeSharedItem({ createdAt: NaN }), LATER)).toBe(1);
  });
});

describe('the card', () => {
  const card = (over: Partial<SharedItem>) =>
    render(<SharedItemCard item={makeSharedItem({ name: 'Example', ...over })} />).container.firstElementChild as HTMLElement;
  const shortDate = (ts: number) =>
    new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  it('says when the item was added, to the minute', () => {
    const added = new Date(2026, 9, 28, 14, 5).getTime();
    card({ createdAt: added });
    const date = screen.getByText(shortDate(added));
    expect(date.textContent).toMatch(/05/);
    expect(date.getAttribute('title')).toMatch(/^Added .*2026.* deleted from every device on /);
  });

  it('no date for an unreadable creation time', () => {
    card({ createdAt: NaN });
    expect(screen.queryByTitle(/^Added /)).toBeNull();
  });

  it('a fresh item is fully visible', () => {
    expect(card({}).style.opacity).toBe('');
  });

  it('five days before the 30 are up, it is fading', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATER);
    expect(Number(card({ createdAt: LATER - 25 * DAY }).style.opacity)).toBeCloseTo(0.6);
  });

  it('an item added in Paranoid Mode keeps its countdown and does not fade', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATER);
    const el = card({ createdAt: LATER - 2 * HOUR, expiresAt: LATER + 10 * HOUR });
    expect(el.style.opacity).toBe('');
    expect(screen.getByText('Deletes in 10h')).toBeInTheDocument();
  });
});
