import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData, makeSharedItem } from '../helpers/sync-helpers';
import type { SyncData, Task, TaskList } from '../../db/models';

// Reliability review 2026-11-27 (enrolment, backups and restore, device changes,
// stuck states): each test here failed on the code before the fix it covers.

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
  importData, forcePush, restoreFromBackup, remoteKeyIsCurrent, forgetRepositorySyncState,
  contentReplacedByLinking, SNAPSHOT_FILE, CHANGELOG_FILE, ROTATION_MARKER_FILE,
} from '../../sync/sync-engine';
import { BACKUP_FILES } from '../../sync/remote-backups';
import {
  cacheEncryptionKey, clearEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData,
  encryptChangeEntries,
} from '../../sync/crypto';
import { awaitingCatchUpSync } from '../../db';
import { checkRecurringTasks } from '../../hooks/use-recurring';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let shaCounter = 0;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => remote.get(path) ?? null);
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
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

async function encrypted(overrides: Partial<SyncData> = {}): Promise<string> {
  const data = makeSyncData({
    encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey),
    sharedItems: [], mindmapFolders: [], mindmaps: [], mindmapNodes: [], ...overrides,
  }) as SyncData;
  return JSON.stringify(await encryptSyncData(testKey, data));
}

async function setRemote(overrides: Partial<SyncData> = {}) {
  remote.set(SNAPSHOT_FILE, { data: await encrypted(overrides), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(await encryptChangeEntries(testKey, [])), sha: `sha-${++shaCounter}` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

describe('restoring a remote backup', () => {
  it('a backup that is missing costs no safety copy (it used to push out the held one)', async () => {
    await setRemote({ taskLists: [list('l1')] });
    await db.taskLists.add(list('l1', 'CURRENT'));
    const before = await db.localBackups.count();

    await restoreFromBackup('daily'); // no daily file in the repo

    expect(await db.localBackups.count()).toBe(before);
    expect((await db.taskLists.get('l1'))?.name).toBe('CURRENT');
  });

  it('keeps Shared Folder items added after the backup was taken', async () => {
    const old = makeSharedItem({ id: 'old', name: 'in the backup' });
    const added = makeSharedItem({ id: 'added', name: 'added since' });
    await setRemote({ taskLists: [list('l1')], sharedItems: [old, added] });
    await db.sharedItems.bulkAdd([old, added]);
    remote.set(BACKUP_FILES.daily, {
      data: JSON.stringify({ ...JSON.parse(await encrypted({ taskLists: [list('l1', 'BACKUP')], sharedItems: [old] })), backedUpAt: 1 }),
      sha: 'b1',
    });

    await restoreFromBackup('daily');

    expect((await db.taskLists.get('l1'))?.name).toBe('BACKUP');
    expect((await db.sharedItems.toArray()).map((i) => i.id).sort()).toEqual(['added', 'old']);
    expect((await remoteSnapshot()).sharedItems!.map((i) => i.id).sort()).toEqual(['added', 'old']);
  });
});

describe('importing with sync off', () => {
  it('leaves the device as never synced, so linking asks before replacing and joins', async () => {
    await setupSyncCredentials({ syncEnabled: false, githubPat: undefined as never, githubRepo: undefined as never });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });

    await importData({ exportVersion: 1, exportedAt: Date.now(), taskLists: [list('l1')], tasks: [task('t1')], subtasks: [] } as never);

    expect(await db.tasks.count()).toBe(1);
    expect((await db.syncMeta.get('sync-meta'))?.lastPulledAt).toBeUndefined();
  });
});

describe('a remote that lost its snapshot keeps its key', () => {
  it('Force Push reuses the salt the repository last opened with (a fresh one orphaned every file and backup)', async () => {
    await db.syncMeta.update('sync-meta', { encryptedRepo: 'user/repo', encryptedSalt: testSalt, lastPulledAt: Date.now() });
    clearEncryptionKey(); // a reload, or a lock
    await db.taskLists.add(list('l1'));

    await forcePush();

    const pushed = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    expect(pushed.encryptionSalt).toBe(testSalt);
    expect((await remoteSnapshot()).taskLists.map((l) => l.id)).toEqual(['l1']);
  });
});

describe('rows this device cannot read never go up whole', () => {
  it('Force Push keeps the remote copy of a row held here as an unreadable placeholder', async () => {
    const good = { ...task('t1', 'l1', 'THE REAL TITLE'), description: 'kept' } as Task;
    await setRemote({ taskLists: [list('l1')], tasks: [good] });
    await db.taskLists.add(list('l1'));
    await db.tasks.add({ ...task('t1', 'l1', '⚠︎ unreadable'), _decryptError: true } as Task);

    await forcePush();

    const t1 = (await remoteSnapshot()).tasks.find((t) => t.id === 't1');
    expect(t1?.title).toBe('THE REAL TITLE');
    expect((t1 as { _decryptError?: boolean })._decryptError).toBeUndefined();
  });
});

describe('moving a syncing device to another repository', () => {
  it('forgets the old repository\'s state, so the link asks first and joins', async () => {
    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(), lastWipeSeenAt: 5, encryptedRepo: 'user/repo', encryptedSalt: testSalt,
      keyRotation: { newSalt: 's', newVerifier: 'v', startedAt: 1 }, conflictBaseSince: 42,
    });
    await db.taskLists.add(list('l1'));
    await setRemote({ taskLists: [list('other')] });

    expect(await contentReplacedByLinking('pat', 'user/other')).toBeNull(); // as before: a synced device isn't asked
    expect(await contentReplacedByLinking('pat', 'user/other', true)).toMatchObject({ lists: 1 });

    await forgetRepositorySyncState();
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta).toMatchObject({ id: 'sync-meta', conflictBaseSince: 42 });
    expect(meta?.lastPulledAt).toBeUndefined();
    expect(meta?.lastWipeSeenAt).toBeUndefined();
    expect(meta?.encryptedSalt).toBeUndefined();
    expect(meta?.keyRotation).toBeUndefined();
  });
});

describe('an abandoned password-change mark', () => {
  const HOUR = 60 * 60_000;

  it('one whose change committed (the key in use is its key) is removed, and writes go on', async () => {
    await setRemote();
    remote.set(ROTATION_MARKER_FILE, {
      data: JSON.stringify({ newSalt: testSalt, newVerifier: await createVerifier(testKey), startedAt: Date.now() - 2 * HOUR }),
      sha: 'm1',
    });
    expect(await remoteKeyIsCurrent()).toBe(true);
    expect(remote.has(ROTATION_MARKER_FILE)).toBe(false);
  });

  it('one that never committed is pinned here, so Settings offers to finish or forget it', async () => {
    await setRemote();
    const other = await deriveKey('another-password', generateSalt());
    const pin = { newSalt: 'other-salt', newVerifier: await createVerifier(other), startedAt: Date.now() - 2 * HOUR };
    remote.set(ROTATION_MARKER_FILE, { data: JSON.stringify(pin), sha: 'm1' });

    expect(await remoteKeyIsCurrent()).toBe(false);
    expect((await db.syncMeta.get('sync-meta'))?.keyRotation).toEqual(pin);
  });

  it('a fresh one (a change in progress on another device) is left alone', async () => {
    await setRemote();
    const pin = { newSalt: testSalt, newVerifier: await createVerifier(testKey), startedAt: Date.now() - 60_000 };
    remote.set(ROTATION_MARKER_FILE, { data: JSON.stringify(pin), sha: 'm1' });

    expect(await remoteKeyIsCurrent()).toBe(false);
    expect(remote.has(ROTATION_MARKER_FILE)).toBe(true);
    expect((await db.syncMeta.get('sync-meta'))?.keyRotation).toBeUndefined();
  });
});

describe('a device back after more than a month', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('resets no recurring task before it has synced (the reset brought back what was deleted elsewhere)', async () => {
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 31 * DAY });
    await db.taskLists.add(list('l1'));
    await db.tasks.add({
      ...task('r1'), status: 'done', recurrenceType: 'time-based', recurrenceInterval: 1, recurrenceUnit: 'days',
      nextOccurrence: Date.now() - DAY,
    } as Task);

    expect(await awaitingCatchUpSync()).toBe(true);
    await checkRecurringTasks();
    expect((await db.tasks.get('r1'))?.status).toBe('done');
    expect(await db.changeLog.count()).toBe(0);

    // Once synced, it is current again, and the same check resets it.
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() });
    expect(await awaitingCatchUpSync()).toBe(false);
    await checkRecurringTasks();
    expect((await db.tasks.get('r1'))?.status).not.toBe('done');
  });

  it('a device that syncs regularly, or has sync off, is not held', async () => {
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - DAY });
    expect(await awaitingCatchUpSync()).toBe(false);
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 31 * DAY });
    await db.localSettings.update('local', { syncEnabled: false });
    expect(await awaitingCatchUpSync()).toBe(false);
  });
});
