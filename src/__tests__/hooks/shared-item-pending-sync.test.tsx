// @vitest-environment jsdom
// A Shared Folder item this device hasn't uploaded yet carries a "not synced
// yet" mark on its card; once a sync has pushed it, the mark goes. Without sync
// nothing is marked: nothing would ever be uploaded.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { makeSharedItem } from '../helpers/sync-helpers';
import { createLinkItem, usePendingSharedItemIds } from '../../hooks/use-shared-items';
import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import type { ChangeEntry } from '../../db/models';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/sync-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/sync-engine')>()),
  scheduleSyncDebounced: vi.fn(), // no sync runs here: the entries stay until the test clears them
}));

beforeEach(async () => {
  await resetDb();
});

const syncOn = () => db.localSettings.put({ id: 'local', syncEnabled: true, syncIntervalMs: 60_000 });

const entry = (entityType: ChangeEntry['entityType'], entityId: string): ChangeEntry => ({
  id: `c-${entityType}-${entityId}`,
  deviceId: 'd1',
  timestamp: Date.now(),
  entityType,
  entityId,
  operation: 'upsert',
  data: {},
  v: 12,
});

describe('usePendingSharedItemIds', () => {
  it('a new item is waiting until its change is pushed, then not', async () => {
    await syncOn();
    const { result } = renderHook(() => usePendingSharedItemIds());
    let item: Awaited<ReturnType<typeof createLinkItem>>;
    await act(async () => { item = await createLinkItem('https://example.com', 'Example'); });
    await waitFor(() => expect(result.current.has(item!.id)).toBe(true));

    // What a successful push does: its entries leave the change log.
    await db.changeLog.clear();
    await waitFor(() => expect(result.current.has(item!.id)).toBe(false));
  });

  it('only shared items: a pending task or list is not one', async () => {
    await syncOn();
    await db.changeLog.bulkAdd([entry('sharedItem', 's1'), entry('task', 't1'), entry('taskList', 'l1')]);
    const { result } = renderHook(() => usePendingSharedItemIds());
    await waitFor(() => expect([...result.current]).toEqual(['s1']));
  });

  it('without sync nothing is marked, even with changes in the log', async () => {
    await db.localSettings.put({ id: 'local', syncEnabled: false, syncIntervalMs: 60_000 });
    await db.changeLog.add(entry('sharedItem', 's1'));
    const { result } = renderHook(() => usePendingSharedItemIds());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.size).toBe(0);
  });

  it('turning sync on marks what is waiting', async () => {
    await db.changeLog.add(entry('sharedItem', 's1'));
    const { result } = renderHook(() => usePendingSharedItemIds());
    await syncOn();
    await waitFor(() => expect(result.current.has('s1')).toBe(true));
  });
});

describe('the card', () => {
  it('marks an item not synced yet', () => {
    render(<SharedItemCard item={makeSharedItem()} pending />);
    const mark = screen.getByRole('img', { name: 'Not synced yet' });
    expect(mark.getAttribute('title')).toMatch(/next sync/);
  });

  it('a synced item has no mark, as before', () => {
    render(<SharedItemCard item={makeSharedItem()} />);
    expect(screen.queryByRole('img', { name: 'Not synced yet' })).toBeNull();
  });
});
