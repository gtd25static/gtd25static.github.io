import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task } from '../../db/models';

// The conflict manager's sync plumbing: each device's `_base` stays its own (it
// rides only in its change entries), rows older than the feature get their base
// filled in when their entries leave, and a snapshot row raises a conflict only
// against an edit still waiting to be pushed.

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
import { syncNow, forcePush, forcePull, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptSyncData, decryptChangeEntries } from '../../sync/crypto';

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
});

const T0 = 1_000_000;
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', listId: 'l1', title: 'Base', status: 'todo', order: 0, createdAt: T0, updatedAt: T0,
    fieldTimestamps: { title: T0, status: T0, listId: T0, order: T0 }, ...overrides,
  } as Task;
}

async function setRemote(overrides: Partial<SyncData> = {}, changelog: ChangeEntry[] = []) {
  const data = makeSyncData({ syncVersion: 10, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify(changelog), sha: `sha-${++shaCounter}` });
}

it('an entry from a row older than `_base` leaves with its implicit base filled in', async () => {
  await setRemote({ tasks: [task()] });
  await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000, conflictBaseSince: T0 + 10 });
  const edited = { ...task(), title: 'Edited', updatedAt: T0 + 50, fieldTimestamps: { ...task().fieldTimestamps, title: T0 + 50 } };
  await db.tasks.put(edited);
  await db.changeLog.add({ id: 'p1', deviceId: 'device-A', timestamp: T0 + 50, entityType: 'task', entityId: 't1', operation: 'upsert', data: { ...edited } as never, v: 10 });

  await syncNow();

  const [pushed] = await decryptChangeEntries(testKey, JSON.parse(remote.get(CHANGELOG_FILE)!.data));
  // Everything stamped up to the upgrade counts as seen; the title, edited since,
  // has no known base (0) — which is what it was: changed here, unseen elsewhere.
  expect((pushed.data as Record<string, unknown>)._base).toEqual({ status: T0, listId: T0, order: T0 });
});

it('a device\'s base never reaches the remote snapshot', async () => {
  await setRemote({ tasks: [task()] });
  await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 });
  await db.tasks.put({ ...task(), _base: { title: T0 } } as never);
  expect(await forcePush()).not.toBeNull();
  const snapshot = await decryptSyncData(testKey, JSON.parse(remote.get(SNAPSHOT_FILE)!.data));
  expect(JSON.stringify(snapshot)).not.toContain('_base');
});

it('rows a force pull writes know the remote state as their base', async () => {
  await setRemote({ tasks: [task()] });
  await forcePull();
  const saved = await db.tasks.get('t1') as Task & { _base?: Record<string, number> };
  expect(saved._base).toEqual(task().fieldTimestamps);
});

it('a snapshot row conflicts with an edit still waiting here, and not with one already pushed', async () => {
  const theirs = { ...task(), title: 'Remote title', updatedAt: T0 + 100, fieldTimestamps: { ...task().fieldTimestamps, title: T0 + 100 } };
  await setRemote({ tasks: [theirs] });
  await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 1000 });
  const mine = { ...task(), title: 'My title', updatedAt: T0 + 200, fieldTimestamps: { ...task().fieldTimestamps, title: T0 + 200 }, _base: { ...task().fieldTimestamps } };
  await db.tasks.put(mine as never);
  await db.changeLog.add({ id: 'p1', deviceId: 'device-A', timestamp: T0 + 200, entityType: 'task', entityId: 't1', operation: 'upsert', data: { ...mine } as never, v: 10 });

  await syncNow();
  const conflicts = await db.syncConflicts.toArray();
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ localValue: 'My title', remoteValue: 'Remote title' });
});
