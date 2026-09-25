import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// Connecting sync on a device that already holds data used to replace that data
// with the remote's, silently: the device's own lists never reached the others,
// and the only copy was a safety backup that the next app start could evict.
// Joining now keeps what only this device had and uploads it.

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
  maybeCompactBlobBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/history-compaction', () => ({ maybeSquashDefaultBranch: vi.fn(() => Promise.resolve()) }));

import { getFile, putFile } from '../../sync/github-api';
import { syncNow, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData, decryptChangeEntries } from '../../sync/crypto';

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

const T0 = Date.now() - 60_000;
const list = (id: string, name: string): TaskList => ({ id, name, type: 'tasks', order: 0, createdAt: T0, updatedAt: T0 } as TaskList);
const task = (id: string, listId: string, title: string): Task =>
  ({ id, listId, title, status: 'todo', order: 0, createdAt: T0, updatedAt: T0 } as Task);

async function setRemote(overrides: Partial<SyncData>) {
  const data = makeSyncData({ encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
}

async function pushedEntityIds(): Promise<string[]> {
  const entries = JSON.parse(remote.get(CHANGELOG_FILE)!.data) as ChangeEntry[];
  return (await decryptChangeEntries(testKey, entries)).map((e) => e.entityId).sort();
}

describe('joining an existing repo from a device that already has data', () => {
  it('keeps this device\'s own lists and tasks and uploads them', async () => {
    await setRemote({ taskLists: [list('r', 'Remote list')], tasks: [task('rt', 'r', 'Remote task')] });
    await db.taskLists.add(list('l', 'Phone-only list'));
    await db.tasks.add(task('lt', 'l', 'Phone-only task'));

    expect(await syncNow()).toBeGreaterThanOrEqual(0); // joins
    expect(await syncNow()).toBe(0);                   // pushes what it kept

    expect((await db.taskLists.toArray()).map((l) => l.id).sort()).toEqual(['l', 'r']);
    expect((await db.tasks.toArray()).map((t) => t.id).sort()).toEqual(['lt', 'rt']);
    expect(await pushedEntityIds()).toEqual(['l', 'lt']);
  });

  it('folds this device\'s Inbox into the synced one instead of creating a second Inbox', async () => {
    await setRemote({ taskLists: [list('remote-inbox', 'Inbox')] });
    await db.taskLists.add(list('local-inbox', 'Inbox'));
    await db.tasks.add(task('captured', 'local-inbox', 'Captured on the phone'));

    await syncNow();
    await syncNow();

    const lists = await db.taskLists.toArray();
    expect(lists.map((l) => l.id)).toEqual(['remote-inbox']);
    expect((await db.tasks.get('captured'))?.listId).toBe('remote-inbox');
    expect(await pushedEntityIds()).toEqual(['captured']);
  });

  it('a device with nothing of its own just adopts the remote and pushes nothing', async () => {
    await setRemote({ taskLists: [list('r', 'Remote list')] });

    await syncNow();
    await syncNow();

    expect((await db.taskLists.toArray()).map((l) => l.id)).toEqual(['r']);
    expect(await pushedEntityIds()).toEqual([]);
  });
});
