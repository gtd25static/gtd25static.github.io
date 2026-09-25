import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, disableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import { SYNC_LOCK_NAME } from '../../sync/sync-lock';
import type { Task } from '../../db/models';

// Turning Paranoid Mode on or off rewrites every row: read, re-encrypt (or
// decrypt) in memory, write back. A sync applying remote changes in between got
// its rows overwritten by the migration's stale copies (GUI review, suspected).
// The migration now holds the app-wide sync lock, so no sync runs meanwhile.

let held = 0;
const requests: string[] = [];

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
  held = 0;
  requests.length = 0;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, optsOrCb: unknown, maybeCb?: (lock: object | null) => Promise<unknown>) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (lock: object | null) => Promise<unknown>;
        requests.push(name);
        held++;
        try { return await cb({ name }); } finally { held--; }
      },
    },
  });
  await db.tasks.bulkAdd(Array.from({ length: 5 }, (_, i) => (
    { id: `t${i}`, listId: 'l', title: `Task ${i}`, status: 'todo', order: i, createdAt: 1, updatedAt: 1 } as Task
  )));
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
  __resetVaultStateForTests();
});

function recordLockDuringWrites(): boolean[] {
  const seen: boolean[] = [];
  const realBulkPut = db.tasks.bulkPut.bind(db.tasks);
  vi.spyOn(db.tasks, 'bulkPut').mockImplementation(((rows: Task[]) => {
    seen.push(held > 0);
    return realBulkPut(rows);
  }) as never);
  return seen;
}

describe('the at-rest migrations hold the sync lock', () => {
  it('enabling rewrites every row while holding it', async () => {
    const seen = recordLockDuringWrites();
    await enableParanoid('a long enough passphrase 123');
    expect(requests).toContain(SYNC_LOCK_NAME);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('disabling rewrites every row while holding it', async () => {
    await enableParanoid('a long enough passphrase 123');
    requests.length = 0;
    const seen = recordLockDuringWrites();
    await disableParanoid();
    expect(requests).toContain(SYNC_LOCK_NAME);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});
