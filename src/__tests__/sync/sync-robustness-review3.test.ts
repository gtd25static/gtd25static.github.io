import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Sync robustness review 2026-10-16: interrupted operations, devices that come
// back with old changes, and remote data the engine cannot read. The remote here
// is content-addressed like GitHub's (a file's sha is its bytes' hash), so a sha
// read before a change is valid again whenever the bytes come back.

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

import { getFile, putFile, RateLimitError } from '../../sync/github-api';
import { syncNow, wipeAllData, forcePush, setSyncProgressCallback, SNAPSHOT_FILE, CHANGELOG_FILE, type SyncProgress } from '../../sync/sync-engine';
import { cacheEncryptionKey, clearEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, encryptChangeEntries } from '../../sync/crypto';
import { classifySyncError } from '../../sync/sync-errors';
import { toast } from '../../components/ui/Toast';
import { SYNC_VERSION } from '../../sync/version';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let progress: SyncProgress[];
// Hooks to make another device act between two requests of this one.
let afterGet: ((path: string) => Promise<void> | void) | null;
let afterPut: ((path: string) => Promise<void> | void) | null;
// Writes that land with their reply lost, and writes that fail before landing
// (the next one of each path).
let replyLost: Set<string>;
let failNext: Set<string>;

function shaOf(data: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 16777619);
  return `sha-${(h >>> 0).toString(16)}-${data.length}`;
}

function file(data: string) {
  return { data, sha: shaOf(data) };
}

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
  afterGet = null;
  afterPut = null;
  replyLost = new Set();
  failNext = new Set();
  progress = [];
  setSyncProgressCallback((p) => progress.push(p));
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => {
    const current = remote.get(path);
    const copy = current ? { ...current } : null;
    await afterGet?.(path);
    return copy;
  });
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (failNext.delete(path)) throw new TypeError('Failed to fetch');
    const current = remote.get(path);
    if (current ? current.sha !== sha : sha !== undefined) throw new Error('CONFLICT');
    remote.set(path, file(data));
    await afterPut?.(path);
    if (replyLost.delete(path)) throw new TypeError('Failed to fetch');
    return shaOf(data);
  });
});

afterEach(() => setSyncProgressCallback(null));

const now = () => Date.now();

function list(id: string, name: string, at = now()): TaskList {
  return { id, name, type: 'tasks', order: 0, createdAt: at, updatedAt: at, fieldTimestamps: { name: at, type: at, order: at } } as TaskList;
}

function task(id: string, title: string, at = now()): Task {
  return {
    id, listId: 'l1', title, status: 'todo', order: 0, createdAt: at, updatedAt: at,
    fieldTimestamps: { listId: at, title: at, status: at, order: at },
  } as Task;
}

function upsert(deviceId: string, entityType: ChangeEntry['entityType'], row: { id: string; updatedAt: number }, id = `e-${row.id}-${deviceId}`): ChangeEntry {
  return { id, deviceId, timestamp: row.updatedAt, entityType, entityId: row.id, operation: 'upsert', data: { ...row }, v: SYNC_VERSION };
}

async function setRemoteSnapshot(overrides: Partial<SyncData>) {
  const data = makeSyncData({
    syncVersion: SYNC_VERSION, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides,
  }) as SyncData;
  remote.set(SNAPSHOT_FILE, file(JSON.stringify(await encryptSyncData(testKey, data))));
}

async function setRemoteChangelog(entries: ChangeEntry[]) {
  remote.set(CHANGELOG_FILE, file(JSON.stringify(await encryptChangeEntries(testKey, entries))));
}

function remoteChangelog(): ChangeEntry[] {
  return JSON.parse(remote.get(CHANGELOG_FILE)!.data);
}

async function addPendingList(id: string, name: string) {
  const row = list(id, name);
  await db.taskLists.add(row);
  await db.changeLog.add({
    id: `c-${id}`, deviceId: 'device-A', timestamp: row.updatedAt,
    entityType: 'taskList', entityId: id, operation: 'upsert', data: { ...row }, v: SYNC_VERSION,
  });
}

async function syncedBefore() {
  await db.syncMeta.update('sync-meta', { lastPulledAt: now() - 60_000 });
}

const localListIds = async () => (await db.taskLists.toArray()).map((l) => l.id).sort();
const lastError = () => progress.filter((p) => p.phase === 'error').at(-1)?.errorInfo?.category;

describe('a changelog without its snapshot', () => {
  it('is refused when its entries are encrypted: nothing re-encrypted, nothing compacted', async () => {
    await setRemoteChangelog([upsert('device-B', 'taskList', list('b1', 'From B'))]);
    const before = remote.get(CHANGELOG_FILE)!.data;
    await syncedBefore();
    await addPendingList('a1', 'Mine');
    clearEncryptionKey(); // a restart: only the stored password is left

    expect(await syncNow()).toBe(-1);

    expect(putFile).not.toHaveBeenCalled();
    expect(remote.get(CHANGELOG_FILE)!.data).toBe(before);
    expect(remote.has(SNAPSHOT_FILE)).toBe(false);
    expect(lastError()).toBe('corrupt-remote');
    expect(await db.changeLog.count()).toBe(1); // still pending, for a Force Push
  });

  it('is refused in a repository this device has seen encrypted, even when empty', async () => {
    remote.set(CHANGELOG_FILE, file('[]'));
    await db.syncMeta.update('sync-meta', { lastPulledAt: now() - 60_000, encryptedRepo: 'user/repo' });
    await addPendingList('a1', 'Mine');

    expect(await syncNow()).toBe(-1);
    expect(putFile).not.toHaveBeenCalled();
    expect(lastError()).toBe('corrupt-remote');
  });

  it('an empty one (a first sync from a device with no data) is a first sync: the data goes up as a snapshot', async () => {
    remote.set(CHANGELOG_FILE, file('[]'));
    await syncedBefore();
    await addPendingList('a1', 'Mine');
    // The first attempt is cut short, and the app restarts (the key and salt
    // only lived in the page). Taken for an existing repository, the first
    // attempt pushed the edit as an entry under that page's salt, and the
    // compaction meant to upload the snapshot was what failed.
    failNext.add(SNAPSHOT_FILE);
    await syncNow();
    clearEncryptionKey();

    expect(await syncNow()).toBe(0);

    const snapshot = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    const key = await deriveKey('test-password', snapshot.encryptionSalt!);
    expect((await decryptSyncData(key, snapshot)).taskLists.map((l) => l.name)).toEqual(['Mine']);
    expect(remote.get(CHANGELOG_FILE)!.data).toBe('[]');
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('first-time encryption of a changelog written in the clear', () => {
  it('leaves an entry that already carries ciphertext as it is', async () => {
    remote.set(SNAPSHOT_FILE, file(JSON.stringify(makeSyncData({ syncVersion: SYNC_VERSION }))));
    const [encrypted] = await encryptChangeEntries(testKey, [upsert('device-B', 'taskList', list('b1', 'From B'))]);
    remote.set(CHANGELOG_FILE, file(JSON.stringify([encrypted])));
    await syncedBefore();
    await addPendingList('a1', 'Mine');

    await syncNow();

    const pushes = (putFile as Mock).mock.calls.filter((c) => c[2] === CHANGELOG_FILE)
      .map((c) => (JSON.parse(c[3]) as ChangeEntry[]).find((e) => e.id === encrypted.id))
      .filter(Boolean);
    expect(pushes.length).toBeGreaterThan(0);
    for (const pushed of pushes) expect(pushed!.data!._enc).toBe(encrypted.data!._enc);
  });
});

describe('a reset made on another device is adopted by identity', () => {
  it('even when it lands while a sync is under way here', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Before')] });
    remote.set(CHANGELOG_FILE, file('[]'));
    await syncedBefore();
    expect(await syncNow()).toBe(0);

    // The next sync reads the old snapshot; the reset lands right after.
    let landed = false;
    afterGet = async (path) => {
      if (path !== SNAPSHOT_FILE || landed) return;
      landed = true;
      await setRemoteSnapshot({ wipedAt: now(), taskLists: [list('restored', 'Restored')] });
      remote.set(CHANGELOG_FILE, file('[]\n '));
    };
    expect(await syncNow()).toBe(0);
    afterGet = null;
    expect(await localListIds()).toEqual(['old']);

    expect(await syncNow()).toBe(0);
    expect(await localListIds()).toEqual(['restored']);
  });

  it('when this device\'s clock runs ahead of the resetting one', async () => {
    const wipedAt = now();
    await setRemoteSnapshot({ wipedAt, taskLists: [list('restored', 'Restored')] });
    remote.set(CHANGELOG_FILE, file('[]'));
    await db.taskLists.add(list('old', 'Before'));
    await db.syncMeta.update('sync-meta', { lastPulledAt: wipedAt + 5 * 60_000, lastWipeSeenAt: 0 });

    expect(await syncNow()).toBe(0);

    expect(await localListIds()).toEqual(['restored']);
    expect((await db.syncMeta.get('sync-meta'))?.lastWipeSeenAt).toBe(wipedAt);
  });

  it('metadata from an older build (nothing recorded) falls back to the clocks once, then records the reset', async () => {
    const wipedAt = now() - 60 * 60_000;
    await setRemoteSnapshot({ wipedAt, taskLists: [list('mine', 'Mine')] });
    remote.set(CHANGELOG_FILE, file('[]'));
    await db.taskLists.add(list('mine', 'Mine'));
    await db.taskLists.add(list('local-only', 'Not replaced'));
    await syncedBefore(); // after the reset: already adopted back then

    expect(await syncNow()).toBe(0);
    expect(await localListIds()).toEqual(['local-only', 'mine']);
    expect((await db.syncMeta.get('sync-meta'))?.lastWipeSeenAt).toBe(wipedAt);
  });

  it('a force pull records the snapshot it read, so a reset landing just after is still adopted', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Before')] });
    remote.set(CHANGELOG_FILE, file('[]'));
    expect(await syncNow()).toBe(0); // never synced: joins by a pull
    expect((await db.syncMeta.get('sync-meta'))?.lastWipeSeenAt).toBe(0);

    await setRemoteSnapshot({ wipedAt: now() - 1_000, taskLists: [list('restored', 'Restored')] });
    expect(await syncNow()).toBe(0);
    expect(await localListIds()).toEqual(['restored']);
  });
});

describe('a reset leaves a changelog no stale sha can append to', () => {
  it('a push holding the sha of an earlier "[]" is refused after a wipe', async () => {
    await setRemoteSnapshot({ taskLists: [list('old', 'Old')] });
    remote.set(CHANGELOG_FILE, file('[]'));
    const staleSha = remote.get(CHANGELOG_FILE)!.sha;
    await syncedBefore();

    await wipeAllData();

    expect(JSON.parse(remote.get(CHANGELOG_FILE)!.data)).toEqual([]);
    expect(remote.get(CHANGELOG_FILE)!.sha).not.toBe(staleSha);
    await expect(putFile('p', 'r', CHANGELOG_FILE, '[{"id":"pre-reset"}]', staleSha)).rejects.toThrow('CONFLICT');
  });
});

describe('rows missing what their kind requires are skipped', () => {
  it('in a snapshot reconciled here (an empty record would replace the local one)', async () => {
    const at = now() - 120_000;
    await db.tasks.add(task('t1', 'Keep me', at));
    const shell = { id: 't1', listId: 'l1', status: 'todo', order: 0, createdAt: at, updatedAt: at } as unknown as Task;
    await setRemoteSnapshot({ taskLists: [list('l1', 'L', at)], tasks: [shell] });
    remote.set(CHANGELOG_FILE, file('[]'));
    await syncedBefore();

    expect(await syncNow()).toBe(0);
    expect((await db.tasks.get('t1'))?.title).toBe('Keep me');
  });

  it('in changelog entries folded into a snapshot (a force pull, a compaction)', async () => {
    await setRemoteSnapshot({ taskLists: [list('l1', 'L')] });
    const noListId = { id: 't-bad', title: 'x', status: 'todo', order: 0, createdAt: now(), updatedAt: now() };
    await setRemoteChangelog([upsert('device-B', 'task', noListId as unknown as Task)]);

    expect(await syncNow()).toBe(0); // never synced: joins by a pull, which folds the changelog in
    expect(await db.tasks.get('t-bad')).toBeUndefined();
  });
});

describe('a delete stamped before the create it deletes (the creator\'s clock ahead)', () => {
  const setup = async () => {
    const createdAt = now() + 5 * 60_000;
    const created = list('r', 'R', createdAt);
    const del: ChangeEntry = {
      id: 'e-del', deviceId: 'device-B', timestamp: now() + 60_000,
      entityType: 'taskList', entityId: 'r', operation: 'delete', v: SYNC_VERSION,
    };
    await setRemoteSnapshot({});
    await setRemoteChangelog([upsert('device-C', 'taskList', created), del]);
    return del;
  };

  it('still deletes it when both arrive in one sync', async () => {
    const del = await setup();
    await syncedBefore();
    expect(await syncNow()).toBe(0);
    expect((await db.taskLists.get('r'))?.deletedAt).toBe(del.timestamp);
  });

  it('and the fold a pull or a compaction makes keeps the tombstone', async () => {
    const del = await setup();
    expect(await syncNow()).toBe(0); // never synced: joins by a pull
    expect((await db.taskLists.get('r'))?.deletedAt).toBe(del.timestamp);
  });
});

it('a delete in the changelog of an item only the snapshot brings in is applied in the same sync', async () => {
  await setRemoteSnapshot({ taskLists: [list('r', 'Created and compacted while away', now() - 60_000)] });
  await setRemoteChangelog([{
    id: 'e-del', deviceId: 'device-B', timestamp: now(), entityType: 'taskList', entityId: 'r', operation: 'delete', v: SYNC_VERSION,
  }]);
  await syncedBefore();

  expect(await syncNow()).toBe(0);
  expect((await db.taskLists.get('r'))?.deletedAt).toBeTruthy();
});

describe('a change the remote already has is not pushed again', () => {
  it('one a compaction folded in (a keepalive flush that landed): cleared, not re-pushed, no conflict card', async () => {
    const t0 = now() - 120_000;
    const t1 = t0 + 10_000;
    const t2 = t0 + 20_000;
    // Renamed here (pushed by a keepalive flush, still pending)…
    const mine = { ...task('t', 'Mine', t0), title: 'Mine', updatedAt: t1, fieldTimestamps: { listId: t0, title: t1, status: t0, order: t0 }, _base: { listId: t0, title: t0, status: t0, order: t0 } };
    await db.tasks.add(mine as unknown as Task);
    await db.changeLog.add({ id: 'e-mine', deviceId: 'device-A', timestamp: t1, entityType: 'task', entityId: 't', operation: 'upsert', data: { ...mine, _base: undefined }, v: SYNC_VERSION });
    // …refined on another device after seeing it, and both compacted.
    const refined = { ...task('t', 'Mine, refined', t0), updatedAt: t2, fieldTimestamps: { listId: t0, title: t2, status: t0, order: t0 } };
    await setRemoteSnapshot({ taskLists: [list('l1', 'L', t0)], tasks: [refined as Task], compactedEntryIds: ['e-mine', 'e-refined'] });
    remote.set(CHANGELOG_FILE, file('[]'));
    await syncedBefore();

    expect(await syncNow()).toBe(0);

    expect(await db.changeLog.count()).toBe(0);
    const pushedMine = (putFile as Mock).mock.calls.some((c) => c[2] === CHANGELOG_FILE && c[3].includes('e-mine'));
    expect(pushedMine).toBe(false);
    expect(await db.syncConflicts.count()).toBe(0);
    expect((await db.tasks.get('t'))?.title).toBe('Mine, refined');
  });

  it('a compaction records the ids it folded', async () => {
    await setRemoteSnapshot({});
    const entries = Array.from({ length: 31 }, (_, i) => upsert('device-B', 'taskList', list(`b${i}`, `List ${i}`)));
    await setRemoteChangelog(entries);
    await syncedBefore();

    expect(await syncNow()).toBe(0);

    const snapshot = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    expect(snapshot.compactedEntryIds).toEqual(expect.arrayContaining(entries.map((e) => e.id)));
    expect(remoteChangelog()).toEqual([]);
  });
});

it('a first upload whose changelog reply was lost: the next sync carries on, keeping what was edited since', async () => {
  await addPendingList('l1', 'First');
  replyLost.add(CHANGELOG_FILE);
  expect(await syncNow()).toBe(-1);

  await addPendingList('l2', 'Made after');
  expect(await syncNow()).toBe(0);

  expect(await localListIds()).toEqual(['l1', 'l2']);
  expect(remoteChangelog().map((e) => e.entityId)).toContain('l2');
  expect(toast).not.toHaveBeenCalledWith('Force pull complete', 'success');
});

it('force push keeps the entries another device pushed between its read and its clear', async () => {
  await setRemoteSnapshot({ taskLists: [list('l1', 'One')] });
  await setRemoteChangelog([upsert('device-B', 'taskList', list('l1', 'One, renamed'))]);
  await db.taskLists.add(list('l1', 'One'));
  await syncedBefore();
  const [late] = await encryptChangeEntries(testKey, [upsert('device-B', 'taskList', list('l2', 'Late'))]);
  afterPut = (path) => {
    if (path !== SNAPSHOT_FILE) return;
    afterPut = null;
    remote.set(CHANGELOG_FILE, file(JSON.stringify([...remoteChangelog(), late])));
  };

  await forcePush();

  expect(remoteChangelog().map((e) => e.id)).toEqual([late.id]);
});

describe('a changelog that cannot be read is never written over', () => {
  it.each([
    ['not JSON', 'not json {{{'],
    ['JSON that is not a list', '{"length":1}'],
    ['null', 'null'],
  ])('%s: refused, nothing written', async (_label, data) => {
    await setRemoteSnapshot({});
    remote.set(CHANGELOG_FILE, file(data));
    await syncedBefore();
    await addPendingList('a1', 'Mine');

    expect(await syncNow()).toBe(-1);
    expect(putFile).not.toHaveBeenCalled();
    expect(remote.get(CHANGELOG_FILE)!.data).toBe(data);
    expect(lastError()).toBe('corrupt-remote');
  });

  it('a null among the entries is left out, the rest applied', async () => {
    await setRemoteSnapshot({});
    const [entry] = await encryptChangeEntries(testKey, [upsert('device-B', 'taskList', list('b1', 'From B'))]);
    remote.set(CHANGELOG_FILE, file(JSON.stringify([null, entry])));
    await syncedBefore();

    expect(await syncNow()).toBe(0);
    expect(await localListIds()).toEqual(['b1']);
  });
});

describe('a new device whose join fails is a failing sync', () => {
  beforeEach(async () => {
    await setRemoteSnapshot({ taskLists: [list('l1', 'One')] });
    remote.set(CHANGELOG_FILE, file('[]'));
  });

  // The first sync reads the snapshot twice (the legacy-format check, its own
  // read) before the pull reads it: the third read is the pull's.
  it('one toast for the streak, not "Force pull failed" at every poll', async () => {
    let snapshotReads = 0;
    afterGet = (path) => {
      if (path === SNAPSHOT_FILE && ++snapshotReads >= 3) throw new Error('GitHub API error: 502');
    };
    expect(await syncNow()).toBe(-1);
    expect(await syncNow()).toBe(-1);

    const messages = (toast as Mock).mock.calls.map((c) => c[0]);
    expect(messages).not.toContain('Force pull failed');
    expect(messages.filter((m) => m === 'Sync failed')).toHaveLength(1);
  });

  it('a rate limit hit by the pull pauses the automatic syncs', async () => {
    let snapshotReads = 0;
    afterGet = (path) => {
      if (path === SNAPSHOT_FILE && ++snapshotReads === 3) throw new RateLimitError(now() + 10 * 60_000);
    };
    expect(await syncNow()).toBe(-1);
    const requests = (getFile as Mock).mock.calls.length;

    expect(await syncNow()).toBe(-1);
    expect((getFile as Mock).mock.calls.length).toBe(requests);
  });
});

it('a TypeError that is not a failed fetch is not "No connection"', () => {
  expect(classifySyncError(new TypeError("Cannot read properties of null (reading 'id')")).category).toBe('unknown');
  expect(classifySyncError(new TypeError('Failed to fetch')).category).toBe('network');
  expect(classifySyncError(new TypeError('Load failed')).category).toBe('network');
});
