import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList, SharedItem } from '../../db/models';

// Reliability review 2026-10-06, batch 3: the sync engine after the 2026-10-05
// fixes — what they missed or broke.

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn(), getFileConditional: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => ({
  ...(await vi.importActual('../../sync/remote-backups')),
  maybeCreateBackups: vi.fn(() => Promise.resolve()),
  backupRemoteSnapshot: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/shared-blobs', async () => ({
  ...(await vi.importActual('../../sync/shared-blobs')),
  compactBlobBranch: vi.fn(() => Promise.resolve(null)),
  maybeCompactBlobBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/history-compaction', () => ({ maybeSquashDefaultBranch: vi.fn(() => Promise.resolve()) }));
// Hooks into two steps, off unless a test turns them on.
const hooks = vi.hoisted(() => ({
  failApply: false,
  alwaysRaced: false,
  duringBackup: null as null | (() => Promise<void>),
}));
vi.mock('../../sync/change-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/change-log')>();
  return {
    ...actual,
    applyRemoteEntries: vi.fn(async (entries: ChangeEntry[]) => (hooks.failApply ? false : actual.applyRemoteEntries(entries))),
    pendingIdsAddedSince: vi.fn(async (before: Set<string>) => hooks.alwaysRaced || actual.pendingIdsAddedSince(before)),
  };
});
vi.mock('../../db/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/backup')>();
  return {
    ...actual,
    createLocalBackup: vi.fn(async (...args: Parameters<typeof actual.createLocalBackup>) => {
      if (hooks.duringBackup) await hooks.duringBackup();
      return actual.createLocalBackup(...args);
    }),
  };
});

import { getFile, putFile, getFileConditional } from '../../sync/github-api';
import { toast } from '../../components/ui/Toast';
import { syncNow, wipeAllData, importData, cheapIdleProbe, forcePushHoldingLock, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, encryptChangeEntries } from '../../sync/crypto';
import { createMindmap } from '../../hooks/use-mindmaps';
import { updateTask } from '../../hooks/use-tasks';

const DAY = 24 * 60 * 60 * 1000;
let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string; etag?: string }>;
let shaCounter = 0;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  hooks.failApply = false;
  hooks.alwaysRaced = false;
  hooks.duringBackup = null;
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => remote.get(path) ?? null);
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (remote.get(path)?.sha !== sha) throw new Error('CONFLICT');
    const next = `sha-${++shaCounter}`;
    remote.set(path, { data, sha: next, etag: `"${next}"` });
    return next;
  });
  (getFileConditional as Mock).mockImplementation(async (_p: string, _r: string, path: string, etag: string | null) => {
    const file = remote.get(path);
    if (!file) return { status: 'absent' };
    if (etag && etag === file.etag) return { status: 'unchanged', etag };
    return { status: 'ok', data: file.data, sha: file.sha, etag: file.etag };
  });
});

afterEach(() => vi.restoreAllMocks());

const T0 = 1_000_000;
const list = (id: string, over: Partial<TaskList> = {}): TaskList =>
  ({ id, name: id, type: 'tasks', order: 0, createdAt: T0, updatedAt: T0, fieldTimestamps: { name: T0, type: T0, order: T0 }, ...over });
const task = (id: string, listId: string, over: Partial<Task> = {}): Task =>
  ({ id, listId, title: id, status: 'todo', order: 0, createdAt: T0, updatedAt: T0, fieldTimestamps: { title: T0, status: T0, listId: T0, order: T0 }, ...over });

async function setRemote(overrides: Partial<SyncData> = {}, changelog: ChangeEntry[] = []) {
  const data = makeSyncData({ syncVersion: 10, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  const s1 = `sha-${++shaCounter}`;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: s1, etag: `"${s1}"` });
  const s2 = `sha-${++shaCounter}`;
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(await encryptChangeEntries(testKey, changelog)), sha: s2, etag: `"${s2}"` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

describe('M9: entries the keepalive flush already sent', () => {
  it('count as pushed (no false conflict later)', async () => {
    await setRemote({ taskLists: [list('l1')], tasks: [task('t1', 'l1')] });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    await db.taskLists.put(list('l1'));
    const mine = task('t1', 'l1', { title: 'Mine', updatedAt: T0 + 50, fieldTimestamps: { ...task('t1', 'l1').fieldTimestamps, title: T0 + 50 } });
    await db.tasks.put(mine);
    const entry: ChangeEntry = { id: 'p1', deviceId: 'device-A', timestamp: T0 + 50, entityType: 'task', entityId: 't1', operation: 'upsert', data: { ...mine } as never, v: 10 };
    await db.changeLog.add(entry);
    // The flush on hide put it on the remote; the local copy is still pending.
    await setRemote({ taskLists: [list('l1')], tasks: [task('t1', 'l1')] }, [entry]);

    await syncNow();

    expect(await db.changeLog.get('p1')).toBeUndefined();
    const row = (await db.tasks.get('t1')) as Task & { _pushed?: Record<string, number> };
    expect(row._pushed?.title).toBe(T0 + 50);
  });
});

describe('B2: the first upload of a device holding only mind maps', () => {
  it('puts them on the remote', async () => {
    const map = (await createMindmap('Only maps here'))!;

    await syncNow();

    const snapshot = await remoteSnapshot();
    expect(snapshot.mindmaps?.map((m) => m.id)).toContain(map.id);
  });
});

describe('B3: import when the Shared Folder on the remote cannot be read', () => {
  it('changes nothing rather than dropping the folder everywhere', async () => {
    const item: SharedItem = { id: 'si1', type: 'link', name: 'Kept', size: 10, url: 'https://kept.example', order: 0, createdAt: T0, updatedAt: T0 };
    await setRemote({ taskLists: [list('l1')], sharedItems: [item] });
    const before = remote.get(SNAPSHOT_FILE)!.sha;
    let changelogReads = 0;
    (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE && ++changelogReads === 1) throw new Error('Failed to fetch');
      return remote.get(path) ?? null;
    });

    await importData({ taskLists: [list('imported')], tasks: [], subtasks: [] });

    expect(remote.get(SNAPSHOT_FILE)!.sha).toBe(before);
    expect((toast as Mock).mock.calls.some(([m]) => /nothing was changed/i.test(String(m)))).toBe(true);
  });
});

describe('B1: a wipe that never reached the remote', () => {
  it('leaves no purge of every shared file armed', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 2 });
    (putFile as Mock).mockImplementation(async () => { throw new Error('Failed to fetch'); });

    await wipeAllData();

    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.blobPurgeAll).toBeFalsy();
    expect(meta?.pendingBlobDeletes).toBe(2);
  });
});

describe('B7: adopting a reset made elsewhere', () => {
  it('keeps an edit made while it was being prepared', async () => {
    await db.taskLists.put(list('l1'));
    await db.tasks.put(task('t1', 'l1'));
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    await setRemote({ taskLists: [list('l1')], tasks: [task('t1', 'l1')], wipedAt: Date.now() - 1000 });
    hooks.duringBackup = async () => {
      hooks.duringBackup = null;
      await updateTask('t1', { title: 'Typed meanwhile' });
    };

    await syncNow();

    expect((await db.tasks.get('t1'))?.title).toBe('Typed meanwhile');
  });
});

describe('M7: a device back after more than 30 days', () => {
  it('moves what was deleted elsewhere (and dropped from the remote) to its Trash, sending no deletes', async () => {
    const lastPulledAt = Date.now() - 40 * DAY;
    await db.syncMeta.update('sync-meta', { lastPulledAt, lastSnapshotSha: 'seen-before' });
    await db.taskLists.bulkPut([list('kept'), list('gone')]);
    await db.tasks.bulkPut([
      task('t-kept', 'kept'),
      task('t-gone', 'gone'),
      task('t-mine', 'kept', { updatedAt: Date.now() - DAY }), // changed here since: not a ghost
    ]);
    await db.changeLog.add({ id: 'pend', deviceId: 'device-A', timestamp: T0, entityType: 'task', entityId: 't-pending', operation: 'upsert', data: { ...task('t-pending', 'kept') } as never, v: 10 });
    await db.tasks.put(task('t-pending', 'kept'));
    await setRemote({ taskLists: [list('kept')], tasks: [task('t-kept', 'kept')] });

    await syncNow();

    const gone = await db.taskLists.get('gone');
    expect(gone?.deletedAt).toBeDefined();
    expect((await db.tasks.get('t-gone'))?.deletedAt).toBe(gone?.deletedAt);
    expect((await db.tasks.get('t-kept'))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get('t-mine'))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get('t-pending'))?.deletedAt).toBeUndefined();
    // Nothing about the ghosts went to the remote.
    const pushed = JSON.parse(remote.get(CHANGELOG_FILE)!.data) as ChangeEntry[];
    expect(pushed.some((e) => e.entityId === 'gone' || e.entityId === 't-gone')).toBe(false);
  });

  it('is retried by the next sync when local edits kept it from finishing', async () => {
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 40 * DAY, lastSnapshotSha: 'seen-before' });
    await db.taskLists.bulkPut([list('kept'), list('gone')]);
    await setRemote({ taskLists: [list('kept')] });
    hooks.alwaysRaced = true;

    await syncNow();
    expect((await db.taskLists.get('gone'))?.deletedAt).toBeUndefined();
    hooks.alwaysRaced = false;
    await syncNow(); // lastPulledAt is recent now; the sweep still owes its run

    expect((await db.taskLists.get('gone'))?.deletedAt).toBeDefined();
    expect((await db.syncMeta.get('sync-meta'))?.awaySweepFrom).toBeUndefined();
  });

  it('leaves a device that synced within the window alone', async () => {
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 10 * DAY, lastSnapshotSha: 'seen-before' });
    await db.taskLists.put(list('local-only'));
    await setRemote({ taskLists: [] });

    await syncNow();

    expect((await db.taskLists.get('local-only'))?.deletedAt).toBeUndefined();
  });
});

describe('B6: a merge that gave up', () => {
  it('leaves the idle probe asking for a full sync', async () => {
    const foreign: ChangeEntry = { id: 'f1', deviceId: 'device-B', timestamp: T0 + 10, entityType: 'taskList', entityId: 'l2', operation: 'upsert', data: { ...list('l2') } as never, v: 10 };
    await setRemote({ taskLists: [list('l1')] }, [foreign]);
    // (pomodoroSyncedAt: no pomodoro push rewriting the snapshot in the same run)
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000, pomodoroSyncedAt: Date.now() });
    hooks.failApply = true;

    await syncNow();
    hooks.failApply = false;

    expect(await cheapIdleProbe()).toBe(true);
  });
});

describe('B8: a password change whose merge at the commit point gives up', () => {
  it('does not push over what other devices compacted meanwhile', async () => {
    const oldSalt = generateSalt();
    const oldKey = await deriveKey('old-password', oldSalt);
    const theirs = { ...SyncDataBase(), taskLists: [list('theirs')], encryptionSalt: oldSalt, encryptionVerifier: await createVerifier(oldKey) };
    remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(oldKey, theirs)), sha: 'snap-old' });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: 'cl-old' });
    hooks.alwaysRaced = true; // local edits keep landing under the merge

    expect(await forcePushHoldingLock({ backupExisting: false, rekeyChangelogFrom: oldKey })).toBeNull();
    expect(remote.get(SNAPSHOT_FILE)!.sha).toBe('snap-old');
  });
});

function SyncDataBase(): SyncData {
  return makeSyncData({ syncVersion: 10 }) as SyncData;
}

describe('B17: importing a backup without pomodoro settings', () => {
  it('keeps this device\'s settings and presets on the remote', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.pomodoroSettings.put({ id: 'pomodoro', masterVolume: 0.3, tickingEnabled: false, bellEnabled: true, activePresetId: 'p1', updatedAt: T0, dynamicMixEnabled: false });
    await db.soundPresets.put({ id: 'p1', name: 'Rain', layers: [], createdAt: T0, updatedAt: T0 } as never);

    await importData({ taskLists: [list('imported')], tasks: [], subtasks: [] });

    const snapshot = await remoteSnapshot();
    expect(snapshot.pomodoroSettings?.masterVolume).toBe(0.3);
    expect(snapshot.soundPresets?.map((p) => p.id)).toEqual(['p1']);
  });
});
