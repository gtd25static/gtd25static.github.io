import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData, makeSharedItem } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Reliability review 2026-10-05, batch B: the operations that replace a whole
// state — wipe, import, backup restore, force pull, the first upload — and what
// an interruption or a transient error between their steps used to leave behind.

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

import { getFile, putFile, deleteFile } from '../../sync/github-api';
import {
  syncNow, wipeAllData, importData, forcePull, forcePush, restoreFromBackup, SNAPSHOT_FILE, CHANGELOG_FILE,
} from '../../sync/sync-engine';
import { BACKUP_FILES } from '../../sync/remote-backups';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, encryptChangeEntries } from '../../sync/crypto';
import { toast } from '../../components/ui/Toast';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let shaCounter = 0;
let failPut: ((path: string) => boolean) | null = null;
let failGet: ((path: string) => boolean) | null = null;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  failPut = null;
  failGet = null;
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => {
    if (failGet?.(path)) throw new Error('GitHub API error: 502');
    return remote.get(path) ?? null;
  });
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (failPut?.(path)) throw new Error('GitHub API error: 502');
    if (remote.get(path)?.sha !== sha) throw new Error('CONFLICT');
    const next = `sha-${++shaCounter}`;
    remote.set(path, { data, sha: next });
    return next;
  });
  (deleteFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => { remote.delete(path); });
});

function list(id: string, name = id): TaskList {
  return { id, name, type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { name: 1 } } as TaskList;
}
function task(id: string, listId = 'l1', title = id): Task {
  return { id, listId, title, status: 'todo', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { title: 1 } } as Task;
}

async function setRemote(overrides: Partial<SyncData> = {}, changelog: ChangeEntry[] = []) {
  const data = makeSyncData({ syncVersion: 9, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), sharedItems: [], mindmapFolders: [], mindmaps: [], mindmapNodes: [], ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(await encryptChangeEntries(testKey, changelog)), sha: `sha-${++shaCounter}` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

function upsert(id: string, entity: TaskList | Task, deviceId = 'device-C'): ChangeEntry {
  const entityType = 'listId' in entity ? 'task' : 'taskList';
  return { id, deviceId, timestamp: Date.now() - 5000, entityType, entityId: entity.id, operation: 'upsert', data: { ...entity } as never, v: 9 };
}

describe('wipe: the remote first, then this device', () => {
  it('a wipe whose remote write fails changes nothing here, and says so', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.taskLists.add(list('l1'));
    failPut = (path) => path === SNAPSHOT_FILE;

    await wipeAllData();

    expect(await db.taskLists.count()).toBe(1);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/nothing was (changed|wiped)/i), 'error');
  });

  it('entries the wipe superseded are not replayed, even when the changelog reset failed', async () => {
    // Another device's edit is in the changelog when the wipe lands.
    await setRemote({ taskLists: [list('l1')] }, [upsert('e-old', list('l1', 'BEFORE WIPE'))]);
    await db.taskLists.add(list('l1'));
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    failPut = (path) => path === CHANGELOG_FILE; // the reset never happens

    await wipeAllData();
    expect(await db.taskLists.count()).toBe(0);

    // This device syncs again, and so does one that missed the wipe.
    failPut = null;
    await syncNow();
    expect(await db.taskLists.count()).toBe(0);

    await db.taskLists.add(list('l1'));
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000, lastWipeSeenAt: undefined });
    await db.localSettings.update('local', { deviceId: 'device-B' });
    const { clearDeviceIdCache } = await import('../../sync/change-log');
    clearDeviceIdCache();
    await syncNow();
    expect(await db.taskLists.count()).toBe(0);
  });
});

describe('import / restore: the remote first, and every collection carried', () => {
  it('an import whose remote write fails leaves this device as it was', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.taskLists.add(list('l1', 'MINE'));
    failPut = (path) => path === SNAPSHOT_FILE;

    await importData({ taskLists: [list('l2', 'IMPORTED')], tasks: [], subtasks: [] } as never);

    expect((await db.taskLists.toArray()).map((l) => l.name)).toEqual(['MINE']);
  });

  it('an import keeps the Shared Folder in the remote snapshot (and adds the backup links)', async () => {
    const file = makeSharedItem({ id: 'si-file', type: 'file', name: 'doc.pdf', blobId: 'b1' });
    await setRemote({ sharedItems: [file] });
    const link = makeSharedItem({ id: 'si-link', type: 'link', url: 'https://example.org' });

    await importData({ taskLists: [list('l2')], tasks: [], subtasks: [], sharedLinks: [link] } as never);

    const ids = ((await remoteSnapshot()).sharedItems ?? []).map((i) => i.id).sort();
    expect(ids).toEqual(['si-file', 'si-link']);
    expect((await db.sharedItems.toArray()).map((i) => i.id).sort()).toEqual(['si-file', 'si-link']);
  });

  it('a restore writes the backup\'s Shared Folder items to the remote, as it does here', async () => {
    const file = makeSharedItem({ id: 'si-file', type: 'file', name: 'doc.pdf', blobId: 'b1' });
    await setRemote({ taskLists: [list('l1')] });
    const backup = await encryptSyncData(testKey, makeSyncData({
      syncVersion: 9, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey),
      taskLists: [list('l-old')], sharedItems: [file],
    }) as SyncData);
    remote.set(BACKUP_FILES.daily, { data: JSON.stringify({ ...backup, backedUpAt: 1 }), sha: 'b-sha' });

    await restoreFromBackup('daily');

    expect(((await remoteSnapshot()).sharedItems ?? []).map((i) => i.id)).toEqual(['si-file']);
    expect((await db.sharedItems.toArray()).map((i) => i.id)).toEqual(['si-file']);
  });
});

describe('force pull: nothing changes here until everything is in hand', () => {
  it('a changelog that cannot be read leaves local data and pending changes as they were', async () => {
    await setRemote({ taskLists: [list('l1', 'REMOTE')] });
    await db.taskLists.add(list('l9', 'LOCAL'));
    await db.changeLog.add(upsert('p1', list('l9', 'LOCAL'), 'device-A'));
    failGet = (path) => path === CHANGELOG_FILE;

    await forcePull();

    expect((await db.taskLists.toArray()).map((l) => l.name)).toEqual(['LOCAL']);
    expect(await db.changeLog.count()).toBe(1);
  });

  it('applies the changelog over the snapshot and drops the discarded pending changes in one step', async () => {
    await setRemote({ taskLists: [list('l1', 'SNAPSHOT')] }, [upsert('e1', { ...list('l1', 'FROM CHANGELOG'), updatedAt: 5, fieldTimestamps: { name: 5 } })]);
    await db.changeLog.add(upsert('p1', list('l9'), 'device-A'));

    await forcePull();

    expect((await db.taskLists.toArray()).map((l) => l.name)).toEqual(['FROM CHANGELOG']);
    expect(await db.changeLog.count()).toBe(0);
    expect((await db.syncMeta.get('sync-meta'))?.lastPulledAt).toBeGreaterThan(0);
  });

  it('recreates a missing changelog, so "Pull from remote" really gets a device out of "Remote is incomplete"', async () => {
    await setRemote({ taskLists: [list('l1')] });
    remote.delete(CHANGELOG_FILE);
    await db.taskLists.add(list('l9'));

    await forcePull();
    expect(remote.has(CHANGELOG_FILE)).toBe(true);
    expect(await syncNow()).toBeGreaterThanOrEqual(0);
  });
});

describe('the first upload and the bootstrap', () => {
  it('an interrupted first upload is finished by the next sync, not refused as "Remote is incomplete"', async () => {
    await db.taskLists.add(list('l1', 'MINE'));
    failPut = (path) => path === CHANGELOG_FILE; // the snapshot lands, the changelog does not
    expect(await syncNow()).toBe(-1);
    expect(remote.has(SNAPSHOT_FILE)).toBe(true);

    failPut = null;
    expect(await syncNow()).toBeGreaterThanOrEqual(0);
    expect(remote.has(CHANGELOG_FILE)).toBe(true);
    expect((await db.taskLists.toArray()).map((l) => l.name)).toEqual(['MINE']);
  });

  it('a bootstrap creates the changelog before replacing anything here', async () => {
    await setRemote({ taskLists: [list('l1', 'REMOTE')] });
    remote.delete(CHANGELOG_FILE);
    failPut = (path) => path === CHANGELOG_FILE;
    expect(await syncNow()).toBe(-1);
    expect(await db.taskLists.count()).toBe(0); // nothing half-adopted
    failPut = null;
    expect(await syncNow()).toBe(0);
    expect((await db.taskLists.toArray()).map((l) => l.name)).toEqual(['REMOTE']);
  });
});

describe('force push refuses to shrink the remote drastically', () => {
  it('refuses when this device holds far fewer items than the remote', async () => {
    await setRemote({ taskLists: [list('l1')], tasks: Array.from({ length: 20 }, (_, i) => task(`t${i}`)) });
    await db.taskLists.add(list('l1'));
    const before = remote.get(SNAPSHOT_FILE)!.sha;

    expect(await forcePush()).toBeNull();
    expect(remote.get(SNAPSHOT_FILE)!.sha).toBe(before);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/refused/i), 'error');
  });
});

describe('whole-state operations take the cross-tab sync lock', () => {
  afterEach(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));

  it('force pull, force push, import, restore and wipe each run under it', async () => {
    const names: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      value: { request: vi.fn(async (name: string, ...rest: unknown[]) => { names.push(name); return (rest.pop() as (l: unknown) => unknown)({ name }); }) },
      configurable: true,
    });
    await setRemote();
    await forcePull();
    await forcePush();
    await importData({ taskLists: [], tasks: [], subtasks: [] } as never);
    await restoreFromBackup('daily');
    await wipeAllData();
    expect(names.filter((n) => n === 'gtd25-sync').length).toBeGreaterThanOrEqual(5);
  });
});
