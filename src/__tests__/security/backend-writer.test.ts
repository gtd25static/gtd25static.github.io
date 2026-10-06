import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { decryptChangeEntries, decryptSyncData, decryptEntity, encryptEntity } from '../../sync/crypto';
import { applyRemoteEntries } from '../../sync/change-log';
import { capFutureTimestamps, MAX_FUTURE_SKEW_MS } from '../../sync/field-timestamps';
import { purgeOldTrashItems } from '../../db/purge';
import { createLocalBackup, getLocalBackups } from '../../db/backup';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// What someone holding the PAT — write access to the repository, no sync
// password (Scenario 7) — could make every device do (threat-model review,
// batch 2). Without the key they cannot read anything; they could still plant
// readable content, make it stick against later edits and deletes, and make
// devices destroy their own copies.

const DAY = 24 * 60 * 60 * 1000;

async function syncKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function upsert(data: Record<string, unknown>, extra: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: `e-${Math.random()}`, deviceId: 'other', timestamp: Date.now(), entityType: 'task',
    entityId: String(data.id), operation: 'upsert', v: 8, data, ...extra,
  };
}

async function seedTask() {
  const now = Date.now();
  await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { name: 1 } } as TaskList);
  await db.tasks.add({
    id: 't1', listId: 'l1', title: 'Mine', status: 'todo', order: 0, createdAt: now, updatedAt: now,
    fieldTimestamps: { title: now, status: now },
  } as Task);
}

beforeEach(async () => {
  await resetDb();
  vi.useRealTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an encrypted remote only speaks ciphertext', () => {
  it('drops a changelog upsert that carries no ciphertext at all', async () => {
    const forged = upsert({ id: 't9', listId: 'l1', title: 'Pay this invoice', link: 'https://phish.example', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 });
    expect(await decryptChangeEntries(await syncKey(), [forged])).toEqual([]);
  });

  it('keeps such entries only for the first encryption of a never-encrypted repository', async () => {
    const legacy = upsert({ id: 't9', listId: 'l1', title: 'Old', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 });
    expect(await decryptChangeEntries(await syncKey(), [legacy], { allowPlaintext: true })).toHaveLength(1);
  });

  it('drops a snapshot row that carries no ciphertext', async () => {
    const key = await syncKey();
    const good = await encryptEntity(key, { id: 't2', listId: 'l1', title: 'ok', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 }, 'task');
    const planted = { id: 't3', listId: 'l1', title: 'Planted', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 };
    const data = { taskLists: [], tasks: [good, planted], subtasks: [], settings: { theme: 'system' } } as unknown as SyncData;
    expect((await decryptSyncData(key, data)).tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('ignores plaintext content set beside genuine ciphertext', async () => {
    const key = await syncKey();
    const enc = await encryptEntity(key, { id: 't2', listId: 'l1', title: 'Real', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 }, 'task');
    const out = await decryptEntity(key, { ...enc, title: 'Forged', description: 'Planted beside it' }, 'task');
    expect(out.title).toBe('Real');
    expect('description' in out).toBe(false);
  });
});

describe('timestamps from the future cannot make a change permanent', () => {
  it('caps field timestamps, updatedAt and the entry time at now + the tolerance', () => {
    const now = 1_000_000;
    const capped = capFutureTimestamps({
      id: 't1', updatedAt: 9e15, deletedAt: 9e15, fieldTimestamps: { title: 9e15, status: 5 },
    }, now);
    expect(capped.updatedAt).toBe(now + MAX_FUTURE_SKEW_MS);
    expect((capped.fieldTimestamps as Record<string, number>).title).toBe(now + MAX_FUTURE_SKEW_MS);
    expect((capped.fieldTimestamps as Record<string, number>).status).toBe(5);
  });

  it('a remote title stamped 9e15 is applied, but a later edit can still win', async () => {
    await seedTask();
    await applyRemoteEntries([upsert(
      { id: 't1', listId: 'l1', title: 'Forged', status: 'todo', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { title: 9e15 } },
      { timestamp: 9e15 },
    )]);
    const row = await db.tasks.get('t1');
    expect(row?.title).toBe('Forged');
    expect(row?.fieldTimestamps?.title).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
  });

  it('a brand-new row keeps no timestamp from the far future either', async () => {
    await seedTask();
    await applyRemoteEntries([upsert({ id: 't5', listId: 'l1', title: 'New', status: 'todo', order: 0, createdAt: 1, updatedAt: 9e15, fieldTimestamps: { title: 9e15 } })]);
    const row = await db.tasks.get('t5');
    expect(row?.updatedAt).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
    expect(row?.fieldTimestamps?.title).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
  });

  it('a delete from the far future cannot outlast every restore', async () => {
    await seedTask();
    await applyRemoteEntries([{ id: 'd1', deviceId: 'other', timestamp: 9e15, entityType: 'task', entityId: 't1', operation: 'delete' }]);
    const row = await db.tasks.get('t1');
    expect(row?.deletedAt).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
  });
});

describe('a delete dated long ago still gets its 30 days in the Trash here', () => {
  it('is not purged at the next start, only 30 days after it arrived', async () => {
    await seedTask();
    await applyRemoteEntries([{ id: 'd1', deviceId: 'other', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'delete' }]);
    expect((await db.tasks.get('t1'))?.deletedAt).toBe(1);

    await purgeOldTrashItems();
    expect(await db.tasks.get('t1')).toBeDefined(); // still in the Trash

    vi.useFakeTimers({ now: Date.now() + 31 * DAY, toFake: ['Date'] });
    await purgeOldTrashItems();
    expect(await db.tasks.get('t1')).toBeUndefined();
  });

  it('a delete made on this device is purged on its own date, as before', async () => {
    await seedTask();
    await db.tasks.update('t1', { deletedAt: Date.now() - 31 * DAY });
    await purgeOldTrashItems();
    expect(await db.tasks.get('t1')).toBeUndefined();
  });
});

describe('remote changes of an unknown kind are ignored, not fatal', () => {
  for (const entityType of ['x', '__proto__', 'constructor']) {
    it(`entityType "${entityType}"`, async () => {
      await seedTask();
      const entry = { ...upsert({ id: 't1', title: 'x' }), entityType } as unknown as ChangeEntry;
      const del = { id: 'd', deviceId: 'o', timestamp: 1, entityType, entityId: 't1', operation: 'delete' } as unknown as ChangeEntry;
      await expect(applyRemoteEntries([entry, del])).resolves.not.toThrow();
      expect((await db.tasks.get('t1'))?.title).toBe('Mine');
    });
  }
});

describe('a burst of remote resets cannot push the pre-reset copy out of the backups', () => {
  it('keeps the oldest copy taken before a reset in the last 24 hours', async () => {
    await seedTask();
    await createLocalBackup(); // before the first reset: the copy that matters
    const [first] = await getLocalBackups();
    for (let i = 0; i < 4; i++) {
      await db.tasks.update('t1', { title: `state ${i}` });
      await new Promise((r) => setTimeout(r, 5));
      await createLocalBackup();
    }
    expect((await getLocalBackups()).map((b) => b.timestamp)).toContain(first.timestamp);
  });
});

describe('the sync token check', () => {
  it('flags a token that can push to the app\'s own site, then a classic one', async () => {
    const { tokenReachWarning } = await import('../../sync/github-api');
    expect(tokenReachWarning({ classicScopes: null, canPushAppSite: true })).toMatch(/hosts this app/);
    expect(tokenReachWarning({ classicScopes: ['repo', 'gist'], canPushAppSite: false })).toMatch(/classic token/);
    expect(tokenReachWarning({ classicScopes: ['gist'], canPushAppSite: false })).toBeNull();
    expect(tokenReachWarning({ classicScopes: null, canPushAppSite: false })).toBeNull();
  });
});

describe('a shared file\'s bytes are bound to its id', () => {
  it('bytes moved to another file\'s place do not open there; old unbound files still open', async () => {
    const { blobAad, decryptSharedBlob } = await import('../../sync/shared-blobs');
    const { encryptBytes } = await import('../../sync/crypto');
    const key = await syncKey();
    const a = await encryptBytes(key, new TextEncoder().encode('file A'), blobAad('A'));
    expect(new TextDecoder().decode(await decryptSharedBlob(key, a, 'A'))).toBe('file A');
    await expect(decryptSharedBlob(key, a, 'B')).rejects.toBeTruthy();
    const legacy = await encryptBytes(key, new TextEncoder().encode('old file'));
    expect(new TextDecoder().decode(await decryptSharedBlob(key, legacy, 'C'))).toBe('old file');
  });
});
