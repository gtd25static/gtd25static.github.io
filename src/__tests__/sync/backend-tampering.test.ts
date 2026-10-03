import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { SyncData, TaskList } from '../../db/models';

// What a writer to the repository (the PAT, no sync password) could make the sync
// engine do, run against an in-memory remote (threat-model review, batch 2).

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
import { syncNow, onEncryptionPasswordNeeded, offEncryptionPasswordNeeded, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';
import { SYNC_VERSION } from '../../sync/version';

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

function list(id: string, name: string): TaskList {
  const now = Date.now();
  return { id, name, type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList;
}

async function setRemoteSnapshot(overrides: Partial<SyncData>) {
  const data = makeSyncData({ encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  if (!remote.has(CHANGELOG_FILE)) remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
}

/** A first sync of this device against the encrypted remote, as in real use. */
async function syncedOnce() {
  await setRemoteSnapshot({ taskLists: [list('l1', 'Work')] });
  await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
  expect(await syncNow()).toBe(0);
}

describe('a repository that loses its salt', () => {
  it('is refused, not taken for a first encryption that would empty every record', async () => {
    await syncedOnce();
    expect((await db.syncMeta.get('sync-meta'))?.encryptedRepo).toBe('user/repo');
    const stripped = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    delete stripped.encryptionSalt;
    delete stripped.encryptionVerifier;
    remote.set(SNAPSHOT_FILE, { data: JSON.stringify(stripped), sha: `sha-${++shaCounter}` });
    const before = remote.get(SNAPSHOT_FILE)!.data;

    expect(await syncNow()).toBe(-1);
    expect(remote.get(SNAPSHOT_FILE)!.data).toBe(before); // nothing pushed over it
    expect((await db.taskLists.get('l1'))?.name).toBe('Work');
  });
});

describe('a verifier that no longer matches', () => {
  it('prompts, saying the key changed — and keeps the saved password', async () => {
    await syncedOnce();
    const otherKey = await deriveKey('someone else', testSalt);
    const snap = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    snap.encryptionVerifier = await createVerifier(otherKey);
    remote.set(SNAPSHOT_FILE, { data: JSON.stringify(snap), sha: `sha-${++shaCounter}` });
    const prompts: Array<{ keyChanged?: boolean } | undefined> = [];
    const listener = (_salt: string, opts?: { keyChanged?: boolean }) => { prompts.push(opts); };
    onEncryptionPasswordNeeded(listener);
    try {
      expect(await syncNow()).toBe(-1);
    } finally {
      offEncryptionPasswordNeeded(listener);
    }
    expect(prompts).toEqual([{ keyChanged: true }]);
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe('test-password');
  });
});

describe('a syncVersion set back by hand', () => {
  it('is migrated up again without keeping it as a migration backup', async () => {
    await syncedOnce();
    expect((await db.syncMeta.get('sync-meta'))?.maxSyncVersionSeen).toBe(SYNC_VERSION);
    const snap = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    snap.syncVersion = SYNC_VERSION - 1;
    remote.set(SNAPSHOT_FILE, { data: JSON.stringify(snap), sha: `sha-${++shaCounter}` });

    expect(await syncNow()).toBe(0);
    expect(remote.has(`gtd25-snapshot-v${SYNC_VERSION - 1}.backup.json`)).toBe(false);
    expect((JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData).syncVersion).toBe(SYNC_VERSION);
  });

  it('control: a genuine upgrade still keeps its migration backup', async () => {
    await setRemoteSnapshot({ syncVersion: SYNC_VERSION - 1, taskLists: [list('l1', 'Work')] });
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    expect(await syncNow()).toBe(0);
    expect(remote.has(`gtd25-snapshot-v${SYNC_VERSION - 1}.backup.json`)).toBe(true);
  });
});
