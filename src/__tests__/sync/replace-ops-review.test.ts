import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData, makeSharedItem } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Final review, whole-state operations (2026-10-05): the force-push shrink guard
// blind to un-compacted deletes, a "failed" wipe whose snapshot landed, stale
// bases carried into the remote, leftovers of a wiped state, a pre-reset entry
// pushed onto a reset changelog, the rate-limit pause on the server's clock.

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => ({
  ...(await vi.importActual('../../sync/remote-backups')),
  maybeCreateBackups: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/shared-blobs', async () => ({
  ...(await vi.importActual('../../sync/shared-blobs')),
  compactBlobBranch: vi.fn(() => Promise.resolve(null)),
  maybeCompactBlobBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/history-compaction', () => ({ maybeSquashDefaultBranch: vi.fn(() => Promise.resolve()) }));

import { getFile, putFile } from '../../sync/github-api';
import { syncNow, wipeAllData, importData, forcePush, forcePull, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, encryptChangeEntries } from '../../sync/crypto';
import { toast } from '../../components/ui/Toast';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let shaCounter = 0;
let onPut: ((path: string, data: string) => void | Promise<void>) | null = null;
let failAfterPut: ((path: string) => boolean) | null = null;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  onPut = null;
  failAfterPut = null;
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => remote.get(path) ?? null);
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (remote.get(path)?.sha !== sha) throw new Error('CONFLICT');
    const next = `sha-${++shaCounter}`;
    remote.set(path, { data, sha: next });
    await onPut?.(path, data);
    if (failAfterPut?.(path)) throw new Error('timeout'); // landed, reply lost
    return next;
  });
});

function list(id: string, name = id): TaskList {
  return { id, name, type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { name: 1 } } as TaskList;
}
function task(id: string): Task {
  return { id, listId: 'l1', title: id, status: 'todo', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { title: 1 } } as Task;
}

async function setRemote(overrides: Partial<SyncData> = {}, changelog: ChangeEntry[] = []) {
  const data = makeSyncData({ syncVersion: 10, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), sharedItems: [], mindmapFolders: [], mindmaps: [], mindmapNodes: [], ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(await encryptChangeEntries(testKey, changelog)), sha: `sha-${++shaCounter}` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

describe('force push and deletes still in the changelog', () => {
  it('counts the remote after its changelog: deleting a project before compaction is not "shrinking"', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
    const deletes: ChangeEntry[] = tasks.map((t, i) => ({ id: `d${i}`, deviceId: 'device-A', timestamp: 10 + i, entityType: 'task', entityId: t.id, operation: 'delete', v: 10 }));
    await setRemote({ taskLists: [list('l1')], tasks }, deletes);
    await db.taskLists.add(list('l1'));
    await db.tasks.add(task('kept'));
    expect(await forcePush()).not.toBeNull();
  });
});

describe('a reset whose reply was lost', () => {
  it('a wipe whose snapshot landed is finished here, not reported as "nothing was wiped"', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.taskLists.add(list('l1'));
    failAfterPut = (path) => path === SNAPSHOT_FILE;
    await wipeAllData();
    expect(await db.taskLists.count()).toBe(0);
    expect(toast).toHaveBeenCalledWith('All data wiped', 'success');
  });
});

describe('a device\'s own sync bookkeeping stays its own', () => {
  it('an import of rows carrying `_base` (from an export) does not put it in the remote snapshot', async () => {
    await setRemote();
    await importData({ taskLists: [{ ...list('l1'), _base: { name: 1 } }], tasks: [], subtasks: [] } as never);
    expect(JSON.stringify(await remoteSnapshot())).not.toContain('_base');
  });

  it('a quarantined row here does not overwrite the remote copy of a kept collection', async () => {
    const good = makeSharedItem({ id: 'si1', type: 'link', name: 'Good name', url: 'https://example.org' });
    await setRemote({ sharedItems: [good] });
    await db.sharedItems.put({ ...good, name: '⚠︎ unreadable', updatedAt: Date.now(), _decryptError: true } as never);
    await importData({ taskLists: [list('l1')], tasks: [], subtasks: [] } as never);
    expect((await remoteSnapshot()).sharedItems!.map((i) => i.name)).toEqual(['Good name']);
  });
});

describe('what a replace leaves behind', () => {
  it('open conflicts go with the state they were about', async () => {
    await setRemote();
    await db.syncConflicts.put({ id: 'c', entityType: 'task', entityId: 't1', field: 'title', kind: 'field', localValue: 'a', remoteValue: 'b', localAt: 1, remoteAt: 2, applied: 'remote', detectedAt: Date.now() });
    await wipeAllData();
    expect(await db.syncConflicts.count()).toBe(0);
  });

  it('adopting a reset drops cached file bytes of items the new state does not list', async () => {
    await setRemote({ taskLists: [list('l1')], wipedAt: Date.now() });
    await db.syncMeta.update('sync-meta', { lastPulledAt: 1 });
    await db.sharedBlobs.put({ id: 'gone-blob', data: new Uint8Array([1]), cachedAt: 1 });
    await syncNow();
    expect(await db.sharedBlobs.count()).toBe(0);
  });

  it('a wipe flags its blob purge so the next compaction purges without the unknown-file grace', async () => {
    await setRemote();
    await wipeAllData();
    expect((await db.syncMeta.get('sync-meta'))?.blobPurgeAll).toBe(true);
  });
});

describe('a sync that read the state before a reset', () => {
  it('does not push its entries onto the reset changelog after a conflict', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    await db.changeLog.add({ id: 'p1', deviceId: 'device-A', timestamp: Date.now(), entityType: 'taskList', entityId: 'l9', operation: 'upsert', data: { ...list('l9') } as never, v: 10 });
    // Another device resets the repository while this sync's PUT is on its way.
    let reset = false;
    const realGet = (getFile as Mock).getMockImplementation()!;
    (getFile as Mock).mockImplementation(async (p: string, r: string, path: string) => {
      const file = await realGet(p, r, path);
      if (path === CHANGELOG_FILE && !reset && (putFile as Mock).mock.calls.length === 0) {
        reset = true;
        const snap = makeSyncData({ syncVersion: 10, wipedAt: Date.now() + 5, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey) }) as SyncData;
        setTimeout(async () => {
          remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, snap)), sha: `sha-${++shaCounter}` });
          remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
        }, 0);
        await new Promise((r2) => setTimeout(r2, 10));
      }
      return file;
    });
    await syncNow();
    expect(remote.get(CHANGELOG_FILE)!.data).toBe('[]'); // nothing pre-reset pushed onto it
  });
});

describe('force pull and its lock', () => {
  it('a failing safety copy does not leave the sync lock held', async () => {
    await setRemote({ taskLists: [list('l1')] });
    const backup = await import('../../db/backup');
    vi.spyOn(backup, 'createLocalBackupOrWarn').mockRejectedValueOnce(new Error('boom'));
    await forcePull().catch(() => undefined);
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    expect(await syncNow()).toBeGreaterThanOrEqual(0);
  });
});
