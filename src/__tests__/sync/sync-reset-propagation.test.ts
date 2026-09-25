import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Wipe / import / backup-restore replace the remote snapshot and reset the
// changelog so every device adopts the new state. These tests run the engine
// against an in-memory remote with real sha checks, because the failure the GUI
// review found only shows across several syncs: the changelog used to be
// DELETED, and the "snapshot but no changelog" guard then refused to sync on
// every device ("Remote data corrupted"), forever.

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
  compactBlobBranch: vi.fn(() => Promise.resolve()),
  maybeCompactBlobBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/history-compaction', () => ({ maybeSquashDefaultBranch: vi.fn(() => Promise.resolve()) }));

import { getFile, putFile, deleteFile } from '../../sync/github-api';
import { syncNow, importData, wipeAllData, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, clearEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData } from '../../sync/crypto';
import { toast } from '../../components/ui/Toast';

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

async function setRemoteSnapshot(overrides: Partial<SyncData>) {
  const data = makeSyncData({ encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

function remoteChangelog(): ChangeEntry[] {
  return JSON.parse(remote.get(CHANGELOG_FILE)?.data ?? 'null');
}

function list(id: string, name: string): TaskList {
  const now = Date.now();
  return { id, name, type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList;
}

async function addPendingList(id: string, name: string) {
  const row = list(id, name);
  await db.taskLists.add(row);
  await db.changeLog.add({
    id: `c-${id}`, deviceId: 'device-A', timestamp: Date.now(),
    entityType: 'taskList', entityId: id, operation: 'upsert', data: { ...row }, v: 7,
  });
}

describe('import / wipe keep the changelog so every device keeps syncing', () => {
  it('import leaves an empty changelog (not a deleted one) and this device keeps pushing', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Before import')] });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });

    await importData({ taskLists: [list('imp', 'Imported')], tasks: [], subtasks: [] });

    expect(remoteChangelog()).toEqual([]);
    expect((await remoteSnapshot()).taskLists.map((l) => l.id)).toEqual(['imp']);

    await addPendingList('after', 'Made after import');
    expect(await syncNow()).toBe(0);
    expect(remoteChangelog().map((e) => e.entityId)).toEqual(['after']);
    expect((await db.taskLists.toArray()).map((l) => l.id).sort()).toEqual(['after', 'imp']);
  });

  it('a list created right after a wipe is pushed, not discarded by a re-bootstrap', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Old')] });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });

    await wipeAllData();
    await addPendingList('fresh', 'After wipe');
    expect(await syncNow()).toBe(0);

    expect(await db.taskLists.get('fresh')).toBeDefined();
    expect(remoteChangelog().map((e) => e.entityId)).toContain('fresh');
  });
});

describe('another device adopting a reset', () => {
  it('bootstraps from the reset snapshot AND applies what was pushed after it', async () => {
    const wipedAt = Date.now() - 1_000;
    await db.syncMeta.update('sync-meta', { lastPulledAt: wipedAt - 60_000 });
    await db.taskLists.add(list('stale', 'Pre-reset data'));
    await setRemoteSnapshot({ wipedAt, taskLists: [list('restored', 'Restored')] });
    const afterReset: ChangeEntry = {
      id: 'e1', deviceId: 'device-B', timestamp: Date.now(),
      entityType: 'taskList', entityId: 'new', operation: 'upsert', data: { ...list('new', 'Added after reset') }, v: 7,
    };
    remote.set(CHANGELOG_FILE, { data: JSON.stringify([afterReset]), sha: `sha-${++shaCounter}` });

    expect(await syncNow()).toBe(0);

    expect((await db.taskLists.toArray()).map((l) => l.id).sort()).toEqual(['new', 'restored']);
    // The other device's post-reset entry must stay on the remote for everyone else.
    expect(remoteChangelog().map((e) => e.id)).toEqual(['e1']);
  });

  it('adopts a given reset only once, even when its clock is behind the resetting device', async () => {
    const wipedAt = Date.now() + 5 * 60_000; // the other device's clock is 5 min ahead
    await setRemoteSnapshot({ wipedAt, taskLists: [list('restored', 'Restored')] });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });

    expect(await syncNow()).toBe(0); // adopts the reset
    await addPendingList('mine', 'Edited after adopting');
    expect(await syncNow()).toBe(0); // must NOT bootstrap again and drop this

    expect(await db.taskLists.get('mine')).toBeDefined();
    expect(remoteChangelog().map((e) => e.entityId)).toContain('mine');
  });
});

describe('repos left without a changelog by older builds', () => {
  it('recreates the changelog and adopts the reset instead of refusing to sync', async () => {
    const wipedAt = Date.now() - 1_000;
    await db.syncMeta.update('sync-meta', { lastPulledAt: wipedAt - 60_000 });
    await db.taskLists.add(list('stale', 'Pre-reset data'));
    await db.tasks.add({ id: 't', listId: 'stale', title: 'x', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
    await setRemoteSnapshot({ wipedAt, taskLists: [list('restored', 'Restored')] });

    expect(await syncNow()).toBe(0);

    expect(remoteChangelog()).toEqual([]);
    expect((await db.taskLists.toArray()).map((l) => l.id)).toEqual(['restored']);
  });

  it('the device that did the reset recreates it and keeps its later edits', async () => {
    const wipedAt = Date.now() - 1_000;
    await db.syncMeta.update('sync-meta', { lastPulledAt: wipedAt + 10 }); // it pulled after its own reset
    await db.taskLists.add(list('restored', 'Restored'));
    await addPendingList('later', 'Edited after the reset');
    await setRemoteSnapshot({ wipedAt, taskLists: [list('restored', 'Restored')] });

    expect(await syncNow()).toBe(0);

    expect(remoteChangelog().map((e) => e.entityId)).toEqual(['later']);
    expect(await db.taskLists.get('later')).toBeDefined();
  });
});

describe('after the cached sync key has expired', () => {
  // The key cache clears after 30 min idle / 5 min hidden. Wipe and import used
  // to skip the remote write silently then, reporting success for a change that
  // only happened on this device.
  beforeEach(async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Everywhere')] });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    await db.taskLists.add(list('old', 'Everywhere'));
    clearEncryptionKey();
  });

  it('wipe re-derives the key from the stored password and wipes the remote too', async () => {
    await wipeAllData();
    expect(await db.taskLists.count()).toBe(0);
    const snap = await remoteSnapshot();
    expect(snap.taskLists).toEqual([]);
    expect(snap.wipedAt).toBeGreaterThan(0);
  });

  it('import re-derives the key and replaces the remote too', async () => {
    await importData({ taskLists: [list('imp', 'Imported')], tasks: [], subtasks: [] });
    expect((await remoteSnapshot()).taskLists.map((l) => l.id)).toEqual(['imp']);
  });

  it('with no usable password, changes nothing anywhere and says so', async () => {
    await db.localSettings.update('local', { encryptionPassword: undefined });
    await wipeAllData();
    expect(await db.taskLists.count()).toBe(1);
    expect((await remoteSnapshot()).taskLists.map((l) => l.id)).toEqual(['old']);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/nothing was (wiped|changed)/i), 'error');
  });
});

describe('while a sync is in flight', () => {
  it('import waits for it instead of silently doing nothing', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Old')] });
    remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });

    // A slow network: the next GitHub read stalls until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realGet = (getFile as Mock).getMockImplementation()!;
    (getFile as Mock).mockImplementationOnce(async (...args: unknown[]) => { await gate; return realGet(...args); });

    const sync = syncNow();
    const imported = importData({ taskLists: [list('imp', 'Imported')], tasks: [], subtasks: [] });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([sync, imported]);

    expect((await db.taskLists.toArray()).map((l) => l.id)).toEqual(['imp']);
    expect((await remoteSnapshot()).taskLists.map((l) => l.id)).toEqual(['imp']);
  });
});
