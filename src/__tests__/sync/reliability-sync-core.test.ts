import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Reliability review 2026-10-05, sync core. Each test is a sequence the review
// found to lose or corrupt data: an edit made while a push is in flight, a form
// save that re-stamps fields it did not change, a remote merge that reverts a
// local edit committed under it, and a force push under the wrong key.

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  // The idle probe's conditional GET: failing, every poll falls through to a full sync.
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn(), getFileConditional: vi.fn(() => Promise.reject(new Error('no network in tests'))) };
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

import { getFile, putFile } from '../../sync/github-api';
import { syncNow, forcePush, startScheduler, stopScheduler, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { applyRemoteEntries } from '../../sync/change-log';
import * as atRestWrites from '../../sync/at-rest-writes';
import { stampChangedFields } from '../../sync/field-timestamps';
import { updateTask } from '../../hooks/use-tasks';
import { updateSubtask } from '../../hooks/use-subtasks';
import { updateTaskList } from '../../hooks/use-task-lists';
import { cacheEncryptionKey, clearEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, encryptChangeEntries, decryptChangeEntries } from '../../sync/crypto';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let shaCounter = 0;
// Runs once inside the next PUT of the given path, before it resolves.
let duringPut: { path: string; fn: () => Promise<void> } | null = null;
// A hook into the remote-apply path: runs once, between applyRemoteEntries'
// reads and its write transaction — the moment a user edit can land. (vi.mock
// does not reach change-log's own import here; spyOn on the namespace does.)
let duringApply: (() => Promise<void>) | null = null;
const realPrepare = atRestWrites.prepareEntityRowsForAtRest;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  duringPut = null;
  duringApply = null;
  vi.spyOn(atRestWrites, 'prepareEntityRowsForAtRest').mockImplementation((async (...args: Parameters<typeof realPrepare>) => {
    const hook = duringApply;
    duringApply = null;
    if (hook) await hook();
    return (realPrepare as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as typeof realPrepare);
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => remote.get(path) ?? null);
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (remote.get(path)?.sha !== sha) throw new Error('CONFLICT');
    const next = `sha-${++shaCounter}`;
    remote.set(path, { data, sha: next });
    if (duringPut?.path === path) {
      const { fn } = duringPut;
      duringPut = null;
      await fn();
    }
    return next;
  });
});

async function setRemote(overrides: Partial<SyncData> = {}, changelog: ChangeEntry[] = []) {
  const data = makeSyncData({ syncVersion: 9, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(changelog), sha: `sha-${++shaCounter}` });
}

async function remoteSnapshot(): Promise<SyncData> {
  return decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
}

function pendingEntry(id: string, title = 'edited'): ChangeEntry {
  const now = Date.now();
  return {
    id, deviceId: 'device-A', timestamp: now, entityType: 'task', entityId: `t-${id}`, operation: 'upsert',
    data: { id: `t-${id}`, listId: 'l1', title, status: 'todo', order: 0, createdAt: now, updatedAt: now }, v: 9,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  const now = Date.now() - 60_000;
  return {
    id, listId: 'l1', title: 'Original', status: 'todo', order: 0, createdAt: now, updatedAt: now,
    fieldTimestamps: { title: now, description: now, status: now, listId: now, order: now },
    ...overrides,
  } as Task;
}

describe('an edit made while a push is in flight is not dropped', () => {
  it('a normal sync clears only the entries it pushed', async () => {
    await setRemote({ taskLists: [] });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    await db.changeLog.add(pendingEntry('first'));
    // The user edits again while the changelog PUT is on the wire.
    duringPut = { path: CHANGELOG_FILE, fn: async () => { await db.changeLog.add(pendingEntry('during')); } };

    expect(await syncNow()).toBeGreaterThanOrEqual(0);

    const left = await db.changeLog.toArray();
    expect(left.map((e) => e.id)).toEqual(['during']);
    expect((await db.syncMeta.get('sync-meta'))?.pendingChanges).toBe(true);
  });

  it('a force push clears only the entries its snapshot carried', async () => {
    await setRemote();
    await db.changeLog.add(pendingEntry('before'));
    duringPut = { path: SNAPSHOT_FILE, fn: async () => { await db.changeLog.add(pendingEntry('during')); } };

    expect(await forcePush()).not.toBeNull();

    expect((await db.changeLog.toArray()).map((e) => e.id)).toEqual(['during']);
  });

  it('the first upload to an empty repo clears only what it uploaded', async () => {
    await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
    await db.changeLog.add(pendingEntry('before'));
    duringPut = { path: SNAPSHOT_FILE, fn: async () => { await db.changeLog.add(pendingEntry('during')); } };

    expect(await syncNow()).toBe(0);

    expect((await db.changeLog.toArray()).map((e) => e.id)).toEqual(['during']);
  });
});

describe('a save stamps only the fields whose value changed', () => {
  it('stampChangedFields leaves equal values (and undefined vs absent) alone', () => {
    const existing = { title: 'A', links: [{ url: 'x' }], fieldTimestamps: { title: 1, links: 1, description: 1 } };
    const ft = stampChangedFields(existing, { title: 'A', links: [{ url: 'x' }], description: undefined, dueDate: 5 }, 99);
    expect(ft).toEqual({ title: 1, links: 1, description: 1, dueDate: 99 });
    expect(stampChangedFields(existing, { title: 'B' }, 99).title).toBe(99);
  });

  it('updateTask re-saving an unchanged title keeps its timestamp, so a rename elsewhere wins', async () => {
    const t = task('t1');
    await db.tasks.add(t);
    await updateTask('t1', { title: 'Original', description: 'new text' });
    const saved = await db.tasks.get('t1');
    expect(saved!.fieldTimestamps!.title).toBe(t.fieldTimestamps!.title);
    expect(saved!.fieldTimestamps!.description).toBeGreaterThan(t.fieldTimestamps!.description!);

    // The other device renamed the task a moment after the base this one edited from.
    const renamedAt = t.fieldTimestamps!.title! + 1000;
    await applyRemoteEntries([{
      id: 'r1', deviceId: 'device-B', timestamp: renamedAt, entityType: 'task', entityId: 't1', operation: 'upsert', v: 9,
      data: { ...t, title: 'Renamed', updatedAt: renamedAt, fieldTimestamps: { ...t.fieldTimestamps, title: renamedAt } },
    }]);
    expect((await db.tasks.get('t1'))!.title).toBe('Renamed');
  });

  it('updateSubtask and updateTaskList do the same', async () => {
    const base = Date.now() - 60_000;
    await db.subtasks.add({ id: 's1', taskId: 't1', title: 'S', status: 'todo', order: 0, createdAt: base, updatedAt: base, fieldTimestamps: { title: base, status: base } } as never);
    await updateSubtask('s1', { title: 'S', status: 'done' });
    expect((await db.subtasks.get('s1'))!.fieldTimestamps!.title).toBe(base);

    await db.taskLists.add({ id: 'l9', name: 'N', type: 'tasks', order: 0, createdAt: base, updatedAt: base, fieldTimestamps: { name: base, type: base } } as TaskList);
    await updateTaskList('l9', { name: 'N', type: 'follow-ups' });
    const list = await db.taskLists.get('l9');
    expect(list!.fieldTimestamps!.name).toBe(base);
    expect(list!.fieldTimestamps!.type).toBeGreaterThan(base);
  });
});

describe('a remote merge does not revert a local edit committed under it', () => {
  it('re-merges a row the user changed between the read and the write', async () => {
    const t = task('t1');
    await db.tasks.add(t);
    const remoteAt = Date.now() - 30_000;
    // While the merge is being prepared, the user edits the description.
    duringApply = async () => { await updateTask('t1', { description: 'typed just now' }); };
    await applyRemoteEntries([{
      id: 'r1', deviceId: 'device-B', timestamp: remoteAt, entityType: 'task', entityId: 't1', operation: 'upsert', v: 9,
      data: { ...t, status: 'done', updatedAt: remoteAt, fieldTimestamps: { ...t.fieldTimestamps, status: remoteAt } },
    }]);
    const saved = await db.tasks.get('t1');
    expect(saved!.description).toBe('typed just now');
    expect(saved!.status).toBe('done');
  });
});

describe('force push writes only under the key the remote was encrypted with', () => {
  it('refuses when the cached key does not open the remote verifier', async () => {
    const otherSalt = generateSalt();
    const otherKey = await deriveKey('the-new-password', otherSalt);
    await setRemote({ encryptionSalt: otherSalt, encryptionVerifier: await createVerifier(otherKey) });
    const before = remote.get(SNAPSHOT_FILE)!.sha;
    await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);

    expect(await forcePush()).toBeNull();
    expect(remote.get(SNAPSHOT_FILE)!.sha).toBe(before);
  });

  it('keeps the remote wipedAt, so a device offline through a reset still adopts it', async () => {
    await setRemote({ wipedAt: 12345 });
    await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
    expect(await forcePush()).not.toBeNull();
    expect((await remoteSnapshot()).wipedAt).toBe(12345);
  });
});

describe('pending entries already on the remote', () => {
  it('re-pushes a pending entry whose remote copy no device can read (a flush across a key change)', async () => {
    const otherKey = await deriveKey('a-password-from-before', generateSalt());
    const entry = pendingEntry('dup');
    await setRemote({}, await encryptChangeEntries(otherKey, [entry]));
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    await db.changeLog.add(entry);

    expect(await syncNow()).toBeGreaterThanOrEqual(0);

    const onRemote = await decryptChangeEntries(testKey, JSON.parse(remote.get(CHANGELOG_FILE)!.data));
    expect(onRemote.map((e) => e.id)).toEqual(['dup']);
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('the keepalive flush on hide', () => {
  afterEach(() => {
    stopScheduler();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  async function startAndSync() {
    await setRemote();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
    startScheduler();
    await vi.waitFor(async () => expect((await db.syncMeta.get('sync-meta'))!.lastPulledAt).toBeGreaterThan(Date.now() - 900));
  }

  function hide() {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function keepalivePuts() {
    return (putFile as Mock).mock.calls.filter((c) => (c[6] as { keepalive?: boolean } | undefined)?.keepalive);
  }

  it('sends a small changelog', async () => {
    await startAndSync();
    await db.changeLog.add(pendingEntry('small'));
    hide();
    await vi.waitFor(() => expect(keepalivePuts()).toHaveLength(1));
  });

  it('skips a body the browser would refuse (over 64 KiB) — the entries go with the next sync', async () => {
    await startAndSync();
    for (let i = 0; i < 40; i++) await db.changeLog.add(pendingEntry(`big-${i}`, 'x'.repeat(2_000)));
    hide();
    await new Promise((r) => setTimeout(r, 200));
    expect(keepalivePuts()).toHaveLength(0);
    expect(await db.changeLog.count()).toBe(40);
  });
});

describe('the legacy single-file format', () => {
  it('keeps the legacy file until the new snapshot is written (no password yet: nothing lost)', async () => {
    remote.set('gtd25-data.json', { data: JSON.stringify(makeSyncData({ taskLists: [{ id: 'l1', name: 'OLD', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 }] })), sha: 'legacy-sha' });
    const { deleteFile } = await import('../../sync/github-api');
    (deleteFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => { remote.delete(path); });
    await db.localSettings.update('local', { encryptionPassword: undefined });
    clearEncryptionKey();

    expect(await syncNow()).toBe(-1); // needs the sync password
    expect(remote.has('gtd25-data.json')).toBe(true);

    await db.localSettings.update('local', { encryptionPassword: 'test-password' });
    expect(await syncNow()).toBe(0);
    expect(remote.has('gtd25-data.json')).toBe(false);
    expect(remote.has(SNAPSHOT_FILE)).toBe(true);
  });
});
