import { vi, type Mock } from 'vitest';
import { db, ensureDefaults } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { SyncData, TaskList } from '../../db/models';

// Reliability review 2026-10-06 (M3): the 12-month retention ran at startup on
// whatever this device held. A list unarchived on another device since this one
// last synced was deleted here — stamped now, so the delete won everywhere. With
// sync on it now waits for the session's first successful sync.

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
import { syncNow, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';

const DAY = 24 * 60 * 60 * 1000;
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

async function setRemote(overrides: Partial<SyncData>) {
  const data = makeSyncData({ syncVersion: 10, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), ...overrides }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: JSON.stringify([]), sha: `sha-${++shaCounter}` });
}

function list(id: string, archivedAt: number | undefined, stampedAt: number): TaskList {
  return {
    id, name: id, type: 'tasks', order: 0, createdAt: 1, updatedAt: stampedAt,
    ...(archivedAt ? { archivedAt } : {}),
    fieldTimestamps: { name: 1, type: 1, order: 1, archivedAt: stampedAt },
  };
}

it('waits for the first sync, and spares a list another device unarchived meanwhile', async () => {
  const archivedLongAgo = Date.now() - 400 * DAY;
  // Here: both lists archived 13 months ago. On the remote: one was unarchived yesterday.
  await db.taskLists.bulkPut([list('kept', archivedLongAgo, archivedLongAgo), list('old', archivedLongAgo, archivedLongAgo)]);
  await setRemote({ taskLists: [list('kept', undefined, Date.now() - DAY), list('old', archivedLongAgo, archivedLongAgo)] });

  await ensureDefaults();
  expect((await db.taskLists.get('kept'))?.deletedAt).toBeUndefined();
  expect((await db.taskLists.get('old'))?.deletedAt).toBeUndefined();

  expect(await syncNow()).toBeGreaterThanOrEqual(0);

  await vi.waitFor(async () => expect((await db.taskLists.get('old'))?.deletedAt).toBeDefined());
  const kept = await db.taskLists.get('kept');
  expect(kept?.deletedAt).toBeUndefined();
  expect(kept?.archivedAt).toBeUndefined();
});

it('without sync, expires at startup as before', async () => {
  await db.localSettings.update('local', { syncEnabled: false });
  const archivedLongAgo = Date.now() - 400 * DAY;
  await db.taskLists.put(list('old', archivedLongAgo, archivedLongAgo));

  await ensureDefaults();

  expect((await db.taskLists.get('old'))?.deletedAt).toBeDefined();
});
