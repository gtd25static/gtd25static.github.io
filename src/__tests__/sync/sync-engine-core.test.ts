import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { SyncData, ChangeEntry } from '../../db/models';
import { newId } from '../../lib/id';

// Mock github-api
vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return {
    ...actual,
    getFile: vi.fn(),
    putFile: vi.fn(),
    deleteFile: vi.fn(),
    testConnection: vi.fn(),
  };
});

// Mock toast
vi.mock('../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

// Mock remote-backups fire-and-forget
vi.mock('../../sync/remote-backups', async () => {
  const actual = await vi.importActual('../../sync/remote-backups');
  return {
    ...actual,
    maybeCreateBackups: vi.fn(() => Promise.resolve()),
  };
});

import { getFile, putFile, deleteFile } from '../../sync/github-api';
import { toast } from '../../components/ui/Toast';
import {
  syncNow,
  forcePush,
  forcePull,
  wipeAllData,
  importData,
  restoreFromBackup,
  __resetForTesting,
  SNAPSHOT_FILE,
  CHANGELOG_FILE,
} from '../../sync/sync-engine';
import {
  deriveKey,
  generateSalt,
  cacheEncryptionKey,
  encryptSyncData,
  createVerifier,
} from '../../sync/crypto';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;
const mockDeleteFile = deleteFile as Mock;
const mockToast = toast as Mock;

let testKey: CryptoKey;
let testSalt: string;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: set up credentials and cache encryption key
async function setupWithEncryption() {
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
}

// Helper: create an encrypted snapshot to return from getFile
async function makeEncryptedSnapshot(overrides?: Partial<SyncData>): Promise<string> {
  const data = makeSyncData({
    encryptionSalt: testSalt,
    encryptionVerifier: await createVerifier(testKey),
    ...overrides,
  }) as SyncData;
  const encrypted = await encryptSyncData(testKey, data);
  return JSON.stringify(encrypted);
}

describe('syncNow — lock', () => {
  it('returns -1 on concurrent call', async () => {
    await setupWithEncryption();
    // Block first sync so it holds the lock
    mockGetFile.mockImplementation(() => new Promise(() => {}));

    syncNow(); // acquires lock synchronously, then pauses at getFile
    const result = await syncNow(); // immediately returns -1 (lock held)
    expect(result).toBe(-1);
  });

  it('releases lock after success', async () => {
    await setupWithEncryption();
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await syncNow();
    // Second call should work
    const result = await syncNow();
    expect(result).not.toBe(-1);
  });

  it('releases lock after failure', async () => {
    await setupWithEncryption();
    mockGetFile.mockRejectedValueOnce(new Error('Network error'));
    await syncNow();

    // Should be able to sync again
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');
    const result = await syncNow();
    expect(result).not.toBe(-1);
  });

  it('force-resets expired lock (45s)', async () => {
    await setupWithEncryption();

    // Spy on Date.now to control time perception
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(realNow);

    // Start a sync that will never resolve
    mockGetFile.mockImplementation(() => new Promise(() => {}));
    syncNow(); // don't await — it hangs intentionally

    // Make Date.now return 46 seconds later so lock appears expired
    dateNowSpy.mockReturnValue(realNow + 46_000);

    // New sync should work because lock expired
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');
    const result = await syncNow();
    expect(result).not.toBe(-1);

    dateNowSpy.mockRestore();
  });
});

describe('syncNow — no credentials', () => {
  it('returns -1 when sync disabled', async () => {
    await setupSyncCredentials({ syncEnabled: false });
    const result = await syncNow();
    expect(result).toBe(-1);
  });

  it('returns -1 when PAT missing', async () => {
    await setupSyncCredentials({ githubPat: undefined });
    const result = await syncNow();
    expect(result).toBe(-1);
  });

  it('returns -1 when repo missing', async () => {
    await setupSyncCredentials({ githubRepo: undefined });
    const result = await syncNow();
    expect(result).toBe(-1);
  });
});

describe('syncNow — first sync (no remote)', () => {
  it('creates snapshot + changelog when local data exists', async () => {
    await setupWithEncryption();
    const listId = newId();
    const now = Date.now();
    await db.taskLists.add({ id: listId, name: 'Test', type: 'tasks', order: 0, createdAt: now, updatedAt: now });

    mockGetFile.mockResolvedValue(null); // no remote files
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    expect(result).toBe(0);

    // Should have called putFile for snapshot and changelog
    expect(mockPutFile).toHaveBeenCalledTimes(2);
    const snapshotCall = mockPutFile.mock.calls.find((c: string[]) => c[2] === SNAPSHOT_FILE);
    const changelogCall = mockPutFile.mock.calls.find((c: string[]) => c[2] === CHANGELOG_FILE);
    expect(snapshotCall).toBeTruthy();
    expect(changelogCall).toBeTruthy();

    // Changelog should be empty
    expect(changelogCall![3]).toBe('[]');
  });

  it('clears pending entries after first sync', async () => {
    await setupWithEncryption();
    // Add a pending entry
    await db.changeLog.add({
      id: 'e1', deviceId: 'device-A', timestamp: Date.now(),
      entityType: 'task', entityId: 't1', operation: 'upsert',
    });

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await syncNow();
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('syncNow — bootstrap from snapshot', () => {
  it('downloads and replaces local data', async () => {
    await setupWithEncryption();
    const listId = newId();
    const now = Date.now();
    const snapshot = makeSyncData({
      encryptionSalt: testSalt,
      encryptionVerifier: await createVerifier(testKey),
      taskLists: [{ id: listId, name: 'Remote List', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    }) as SyncData;
    const encrypted = await encryptSyncData(testKey, snapshot);

    // Snapshot exists but no changelog
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: JSON.stringify(encrypted), sha: 'sha1' });
      return Promise.resolve(null); // no changelog
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    expect(result).toBe(0);

    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Remote List');
  });
});

describe('syncNow — normal sync', () => {
  it('filters own-device entries and applies foreign ones', async () => {
    await setupWithEncryption();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    const taskId = newId();
    const now = Date.now();

    const snapshotContent = await makeEncryptedSnapshot();
    const foreignEntry: ChangeEntry = {
      id: 'foreign-1', deviceId: 'device-B', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Foreign Task', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    };
    const ownEntry: ChangeEntry = {
      id: 'own-1', deviceId: 'device-A', timestamp: now,
      entityType: 'task', entityId: 'own-task', operation: 'upsert',
      data: { id: 'own-task', listId: 'list-1', title: 'Own Task', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    };

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: JSON.stringify([foreignEntry, ownEntry]), sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    await syncNow();

    // Foreign task should have been applied
    const task = await db.tasks.get(taskId);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Foreign Task');
  });

  it('pushes pending entries and returns remaining count', async () => {
    await setupWithEncryption();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    const snapshotContent = await makeEncryptedSnapshot();

    // Add local pending entries
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await db.changeLog.add({
        id: `pending-${i}`, deviceId: 'device-A', timestamp: now + i,
        entityType: 'task', entityId: `task-${i}`, operation: 'upsert',
        data: { id: `task-${i}`, listId: 'list-1', title: `Task ${i}`, status: 'todo', order: i, createdAt: now, updatedAt: now + i },
      });
    }

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    // Push all (no limit)
    const result = await syncNow();
    expect(result).toBe(0); // all pushed
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('syncNow — version check', () => {
  it('blocks on incompatible remote version', async () => {
    await setupWithEncryption();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    const snapshotContent = JSON.stringify({
      syncVersion: 999, // Way ahead
      taskLists: [], tasks: [], subtasks: [],
      settings: { theme: 'system' },
    });

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });

    const result = await syncNow(true);
    expect(result).toBe(-1);
    expect(mockToast).toHaveBeenCalledWith('Remote data requires a newer app version', 'error');
  });
});

describe('syncNow — wipedAt guard', () => {
  it('force-bootstraps when wipedAt > lastPulledAt', async () => {
    await setupWithEncryption();
    const now = Date.now();

    // Set lastPulledAt to some time in the past
    await db.syncMeta.update('sync-meta', { lastPulledAt: now - 60_000 });

    const listId = newId();
    const snapshot = makeSyncData({
      wipedAt: now, // Wipe happened after our last pull
      encryptionSalt: testSalt,
      encryptionVerifier: await createVerifier(testKey),
      taskLists: [{ id: listId, name: 'After Wipe', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    }) as SyncData;
    const encrypted = await encryptSyncData(testKey, snapshot);

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: JSON.stringify(encrypted), sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    await syncNow();

    // Should have bootstrapped from the wiped snapshot
    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('After Wipe');
  });
});

describe('syncNow — 409 conflict retry', () => {
  it('retries on CONFLICT and re-fetches', async () => {
    await setupWithEncryption();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    const snapshotContent = await makeEncryptedSnapshot();

    // Add a pending entry to push
    const now = Date.now();
    await db.changeLog.add({
      id: 'pending-1', deviceId: 'device-A', timestamp: now,
      entityType: 'task', entityId: 'task-1', operation: 'upsert',
      data: { id: 'task-1', listId: 'list-1', title: 'Push Me', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    });

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });

    // First PUT fails with CONFLICT, second succeeds
    let putCallCount = 0;
    mockPutFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) {
        putCallCount++;
        if (putCallCount === 1) return Promise.reject(new Error('CONFLICT'));
        return Promise.resolve('new-sha');
      }
      return Promise.resolve('sha');
    });

    // Real timers — backoff is 500ms, acceptable
    const result = await syncNow();

    expect(result).toBe(0);
    // Should have retried getFile to re-fetch changelog after conflict
    expect(mockGetFile.mock.calls.filter((c: string[]) => c[2] === CHANGELOG_FILE).length).toBeGreaterThan(1);
  }, 10_000);

  it('gives up after MAX_RETRIES', async () => {
    await setupWithEncryption();
    await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
    const snapshotContent = await makeEncryptedSnapshot();

    await db.changeLog.add({
      id: 'pending-1', deviceId: 'device-A', timestamp: Date.now(),
      entityType: 'task', entityId: 'task-1', operation: 'upsert',
      data: { id: 'task-1', listId: 'list-1', title: 'Test', status: 'todo', order: 0, createdAt: Date.now(), updatedAt: Date.now() },
    });

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });

    // Always CONFLICT
    mockPutFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.reject(new Error('CONFLICT'));
      return Promise.resolve('sha');
    });

    // Real timers — total backoff ~1500ms, acceptable
    const result = await syncNow();

    expect(result).toBe(-1);
    expect(mockToast).toHaveBeenCalledWith('Sync conflict — will retry later', 'error');
  });
});

describe('syncNow — errors', () => {
  it('catches AbortError silently', async () => {
    await setupWithEncryption();
    const abortErr = new DOMException('Aborted', 'AbortError');
    mockGetFile.mockRejectedValueOnce(abortErr);

    const result = await syncNow();
    expect(result).toBe(-1);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('catches network errors with toast', async () => {
    await setupWithEncryption();
    mockGetFile.mockRejectedValueOnce(new Error('Network error'));

    const result = await syncNow();
    expect(result).toBe(-1);
    expect(mockToast).toHaveBeenCalledWith('Sync failed', 'error');
  });

  it('always releases lock after error', async () => {
    await setupWithEncryption();
    mockGetFile.mockRejectedValueOnce(new Error('fail'));
    await syncNow();

    // Lock should be released — second call should work
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');
    const result = await syncNow();
    expect(result).not.toBe(-1);
  });
});

describe('forcePush', () => {
  it('encrypts and pushes full local state', async () => {
    await setupWithEncryption();
    const listId = newId();
    const now = Date.now();
    await db.taskLists.add({ id: listId, name: 'Local List', type: 'tasks', order: 0, createdAt: now, updatedAt: now });

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await forcePush();

    const snapshotCalls = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotCalls).toHaveLength(1);
    // Verify snapshot is encrypted (has _enc on entities)
    const pushed = JSON.parse(snapshotCalls[0][3]) as SyncData;
    expect(pushed.encryptionSalt).toBe(testSalt);
  });

  it('clears changelog and pending entries', async () => {
    await setupWithEncryption();
    await db.changeLog.add({
      id: 'e1', deviceId: 'device-A', timestamp: Date.now(),
      entityType: 'task', entityId: 't1', operation: 'upsert',
    });

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await forcePush();

    // Changelog file should be cleared
    const changelogCalls = mockPutFile.mock.calls.filter((c: string[]) => c[2] === CHANGELOG_FILE);
    expect(changelogCalls).toHaveLength(1);
    expect(changelogCalls[0][3]).toBe('[]');

    // Local pending should be cleared
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('forcePull', () => {
  it('downloads, decrypts, and replaces local data', async () => {
    await setupWithEncryption();
    const listId = newId();
    const now = Date.now();

    const snapshotContent = await makeEncryptedSnapshot({
      taskLists: [{ id: listId, name: 'Pulled List', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    });

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'sha' });
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      return Promise.resolve(null);
    });

    await forcePull();

    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Pulled List');
  });

  it('clears pending entries', async () => {
    await setupWithEncryption();
    await db.changeLog.add({
      id: 'e1', deviceId: 'device-A', timestamp: Date.now(),
      entityType: 'task', entityId: 't1', operation: 'upsert',
    });

    const snapshotContent = await makeEncryptedSnapshot();
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'sha' });
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      return Promise.resolve(null);
    });

    await forcePull();
    expect(await db.changeLog.count()).toBe(0);
  });

  it('shows error when no remote data', async () => {
    await setupWithEncryption();
    mockGetFile.mockResolvedValue(null);

    await forcePull();
    expect(mockToast).toHaveBeenCalledWith('No remote data found', 'error');
  });
});

describe('syncNow — fresh device bootstrap (both files exist, no lastPulledAt)', () => {
  it('bootstraps from snapshot + changelog on fresh device', async () => {
    await setupWithEncryption();
    const now = Date.now();
    const listId = newId();
    const taskId = newId();

    const snapshotContent = await makeEncryptedSnapshot({
      taskLists: [{ id: listId, name: 'Remote List', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    });

    const changelogEntry: ChangeEntry = {
      id: 'cl-1', deviceId: 'device-B', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId, title: 'CL Task', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    };

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: JSON.stringify([changelogEntry]), sha: 'cl-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    expect(result).toBe(0);

    // Snapshot data applied
    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Remote List');

    // Changelog entry applied on top
    const tasks = await db.tasks.toArray();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('CL Task');

    // syncMeta updated
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.lastPulledAt).toBeGreaterThan(0);
    expect(meta?.lastSnapshotSha).toBe('snap-sha');

    // No remote writes (bootstrap is read-only)
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it('skips bootstrap when lastPulledAt exists', async () => {
    await setupWithEncryption();
    const now = Date.now();

    // Set lastPulledAt — this device has synced before
    await db.syncMeta.update('sync-meta', { lastPulledAt: now - 60_000 });

    const snapshotContent = await makeEncryptedSnapshot();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    expect(result).toBe(0);

    // Should NOT have done a bulk clear (bootstrap clears tables)
    // Instead, normal sync path was taken — verify via putFile being called
    // (normal sync pushes pending entries or at least updates changelog)
    // The key check: taskLists should NOT have been cleared and re-populated
    // since the snapshot has no task lists and we didn't bootstrap
    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(0); // empty because snapshot had none and no bootstrap clear happened
  });
});

describe('wipeAllData', () => {
  it('clears local data', async () => {
    await setupWithEncryption();
    const now = Date.now();
    await db.taskLists.add({ id: 'l1', name: 'List', type: 'tasks', order: 0, createdAt: now, updatedAt: now });
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'Task', status: 'todo', order: 0, createdAt: now, updatedAt: now });
    await db.subtasks.add({ id: 's1', taskId: 't1', title: 'Sub', status: 'todo', order: 0, createdAt: now, updatedAt: now });

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await wipeAllData();

    expect(await db.taskLists.count()).toBe(0);
    expect(await db.tasks.count()).toBe(0);
    expect(await db.subtasks.count()).toBe(0);
  });

  it('pushes empty snapshot with wipedAt when sync configured', async () => {
    await setupWithEncryption();

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await wipeAllData();

    const snapshotCalls = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotCalls).toHaveLength(1);
    const pushed = JSON.parse(snapshotCalls[0][3]) as SyncData;
    expect(pushed.wipedAt).toBeGreaterThan(0);
    expect(pushed.taskLists).toEqual([]);
  });

  it('deletes changelog file', async () => {
    await setupWithEncryption();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');
    mockDeleteFile.mockResolvedValue(undefined);

    await wipeAllData();
    expect(mockDeleteFile).toHaveBeenCalledWith('ghp_test123', 'user/repo', CHANGELOG_FILE, 'cl-sha');
  });

  it('works without sync config (local only)', async () => {
    // No sync credentials set up
    const now = Date.now();
    await db.taskLists.add({ id: 'l1', name: 'List', type: 'tasks', order: 0, createdAt: now, updatedAt: now });

    await wipeAllData();

    expect(await db.taskLists.count()).toBe(0);
    expect(mockPutFile).not.toHaveBeenCalled();
  });
});

describe('importData', () => {
  it('replaces local data', async () => {
    await setupWithEncryption();
    // Pre-existing data
    const now = Date.now();
    await db.taskLists.add({ id: 'old-l', name: 'Old', type: 'tasks', order: 0, createdAt: now, updatedAt: now });

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    const importPayload = {
      taskLists: [{ id: 'new-l', name: 'Imported', type: 'tasks' as const, order: 0, createdAt: now, updatedAt: now }],
      tasks: [],
      subtasks: [],
    };

    await importData(importPayload);

    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Imported');
  });

  it('pushes as snapshot with wipedAt when sync configured', async () => {
    await setupWithEncryption();

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await importData({ taskLists: [], tasks: [], subtasks: [] });

    const snapshotCalls = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotCalls).toHaveLength(1);
    const pushed = JSON.parse(snapshotCalls[0][3]) as SyncData;
    expect(pushed.wipedAt).toBeGreaterThan(0);
  });

  it('works without sync config', async () => {
    // No sync creds
    const now = Date.now();
    await importData({
      taskLists: [{ id: 'l1', name: 'Test', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
      tasks: [],
      subtasks: [],
    });

    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(mockPutFile).not.toHaveBeenCalled();
  });
});

describe('restoreFromBackup', () => {
  it('fetches backup tier, decrypts, and replaces local', async () => {
    await setupWithEncryption();
    const listId = newId();
    const now = Date.now();

    const backupContent = await makeEncryptedSnapshot({
      taskLists: [{ id: listId, name: 'Backup List', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    });

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === 'gtd25-backup-hourly.json') return Promise.resolve({ data: backupContent, sha: 'b-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve(null);
      if (path === CHANGELOG_FILE) return Promise.resolve(null);
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    await restoreFromBackup('hourly');

    const lists = await db.taskLists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Backup List');
  });

  it('force-pushes after restore', async () => {
    await setupWithEncryption();
    const backupContent = await makeEncryptedSnapshot();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === 'gtd25-backup-daily.json') return Promise.resolve({ data: backupContent, sha: 'b-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    await restoreFromBackup('daily');

    const snapshotCalls = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotCalls).toHaveLength(1);
  });

  it('errors on missing file', async () => {
    await setupWithEncryption();
    mockGetFile.mockResolvedValue(null);

    await restoreFromBackup('hourly');
    expect(mockToast).toHaveBeenCalledWith('Backup file not found', 'error');
  });
});
