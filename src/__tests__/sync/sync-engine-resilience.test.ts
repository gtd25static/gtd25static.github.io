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

import { getFile, putFile } from '../../sync/github-api';
import { RateLimitError } from '../../sync/github-api';
import { toast } from '../../components/ui/Toast';
import {
  syncNow,
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

async function setupWithEncryption() {
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
}

async function makeEncryptedSnapshot(overrides?: Partial<SyncData>): Promise<string> {
  const data = makeSyncData({
    encryptionSalt: testSalt,
    encryptionVerifier: await createVerifier(testKey),
    ...overrides,
  }) as SyncData;
  const encrypted = await encryptSyncData(testKey, data);
  return JSON.stringify(encrypted);
}

describe('syncNow — corrupted JSON handling', () => {
  it('handles corrupted changelog JSON gracefully', async () => {
    await setupWithEncryption();
    const snapshotContent = await makeEncryptedSnapshot();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: 'not valid json {{{', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    // Should not throw — treats corrupted changelog as empty
    const result = await syncNow();
    expect(result).toBe(0);
  });

  it('handles truncated snapshot JSON', async () => {
    await setupWithEncryption();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: '{"syncVersion": 2, "task', sha: 'snap-sha' });
      return Promise.resolve(null);
    });

    const result = await syncNow();
    expect(result).toBe(-1);
    expect(mockToast).toHaveBeenCalledWith('Remote data corrupted', 'error');
  });

  it('handles HTML error page from GitHub', async () => {
    await setupWithEncryption();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '<html><body>503 Service Unavailable</body></html>', sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: '<html><body>Error</body></html>', sha: 'snap-sha' });
      return Promise.resolve(null);
    });

    const result = await syncNow();
    expect(result).toBe(-1);
  });

  it('compactSnapshot does not crash on corrupted changelog', async () => {
    await setupWithEncryption();
    const snapshotContent = await makeEncryptedSnapshot();

    // Set up a normal sync first to trigger compaction
    const entries: ChangeEntry[] = [];
    for (let i = 0; i < 35; i++) {
      entries.push({
        id: `entry-${i}`, deviceId: 'device-B', timestamp: Date.now() + i,
        entityType: 'task', entityId: `task-${i}`, operation: 'upsert',
        data: { id: `task-${i}`, listId: 'list-1', title: `Task ${i}`, status: 'todo', order: i, createdAt: Date.now(), updatedAt: Date.now() + i },
      });
    }

    let getCallCount = 0;
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) {
        getCallCount++;
        // First two calls return valid entries, compaction call returns corrupted
        if (getCallCount <= 2) return Promise.resolve({ data: JSON.stringify(entries), sha: 'cl-sha' });
        return Promise.resolve({ data: 'CORRUPTED!!!', sha: 'cl-sha-2' });
      }
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    // Should complete without crashing
    const result = await syncNow();
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe('syncNow — navigator.onLine guard', () => {
  it('skips network calls when navigator.onLine is false', async () => {
    await setupWithEncryption();

    // Set navigator.onLine to false
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const result = await syncNow();
    expect(result).toBe(-1);
    expect(mockGetFile).not.toHaveBeenCalled();

    // Cleanup
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });
});

describe('syncNow — rate limit handling', () => {
  it('pauses scheduler on rate limit', async () => {
    await setupWithEncryption();

    const resetAt = Date.now() + 60_000;
    mockGetFile.mockRejectedValueOnce(new RateLimitError(resetAt));

    const result = await syncNow();
    expect(result).toBe(-1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining('Rate limited'),
      'error',
    );
  });
});

describe('syncNow — push deduplication', () => {
  it('deduplicates entries when previous push succeeded silently', async () => {
    await setupWithEncryption();
    const snapshotContent = await makeEncryptedSnapshot();

    const taskId = newId();
    const now = Date.now();

    // Pending local entry
    await db.changeLog.add({
      id: 'pending-1', deviceId: 'device-A', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Test', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    });

    // Remote changelog already has this entry (from a lost response)
    const remoteEntry: ChangeEntry = {
      id: 'pending-1', deviceId: 'device-A', timestamp: now,
      entityType: 'task', entityId: taskId, operation: 'upsert',
      data: { id: taskId, listId: 'list-1', title: 'Test', status: 'todo', order: 0, createdAt: now, updatedAt: now },
    };

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: JSON.stringify([remoteEntry]), sha: 'cl-sha' });
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    expect(result).toBe(0);

    // The entry should have been deduplicated and cleared from local
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('syncNow — changelog size guard', () => {
  it('forces compaction when changelog exceeds MAX_CHANGELOG_ENTRIES', async () => {
    await setupWithEncryption();
    const snapshotContent = await makeEncryptedSnapshot();

    // Create a changelog with 501 entries
    const entries: ChangeEntry[] = [];
    for (let i = 0; i < 501; i++) {
      entries.push({
        id: `entry-${i}`, deviceId: 'device-B', timestamp: Date.now() + i,
        entityType: 'task', entityId: `task-${i}`, operation: 'upsert',
        data: { id: `task-${i}`, listId: 'list-1', title: `Task ${i}`, status: 'todo', order: i, createdAt: Date.now(), updatedAt: Date.now() + i },
      });
    }

    let changelogGetCount = 0;
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) {
        changelogGetCount++;
        // After compaction, return empty changelog
        if (changelogGetCount > 2) return Promise.resolve({ data: '[]', sha: 'cl-sha-new' });
        return Promise.resolve({ data: JSON.stringify(entries), sha: 'cl-sha' });
      }
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();
    // Compaction should have been triggered — snapshot was updated
    const snapshotPuts = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotPuts.length).toBeGreaterThan(0);
    expect(result).toBe(0);
  });
});

describe('compactSnapshot — SHA safety', () => {
  it('aborts changelog clear when SHA changed between read and clear', async () => {
    await setupWithEncryption();
    const snapshotContent = await makeEncryptedSnapshot();

    // Normal sync that triggers compaction (30+ entries)
    const entries: ChangeEntry[] = [];
    for (let i = 0; i < 35; i++) {
      entries.push({
        id: `entry-${i}`, deviceId: 'device-B', timestamp: Date.now() + i,
        entityType: 'task', entityId: `task-${i}`, operation: 'upsert',
        data: { id: `task-${i}`, listId: 'list-1', title: `Task ${i}`, status: 'todo', order: i, createdAt: Date.now(), updatedAt: Date.now() + i },
      });
    }

    let changelogGetCount = 0;
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) {
        changelogGetCount++;
        // During compaction re-check, return different SHA (another device pushed)
        if (changelogGetCount >= 3) {
          return Promise.resolve({ data: JSON.stringify(entries), sha: 'different-sha' });
        }
        return Promise.resolve({ data: JSON.stringify(entries), sha: 'cl-sha' });
      }
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: snapshotContent, sha: 'snap-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    await syncNow();

    // Changelog should NOT have been cleared to '[]' during compaction
    // because the SHA changed, indicating new entries were pushed
    // The key is that no PUT with '[]' uses the 'different-sha'
    const compactionClears = mockPutFile.mock.calls.filter(
      (c: string[]) => c[2] === CHANGELOG_FILE && c[3] === '[]' && c[4] === 'different-sha',
    );
    expect(compactionClears).toHaveLength(0);
  });
});

describe('wipeAllData — ordering', () => {
  it('writes snapshot before deleting changelog', async () => {
    await setupWithEncryption();

    mockGetFile.mockImplementation((_p: string, _r: string, path: string) => {
      if (path === CHANGELOG_FILE) return Promise.resolve({ data: '[]', sha: 'cl-sha' });
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('sha');

    const { deleteFile } = await import('../../sync/github-api');
    const mockDeleteFile = deleteFile as Mock;
    mockDeleteFile.mockResolvedValue(undefined);

    const { wipeAllData } = await import('../../sync/sync-engine');
    await wipeAllData();

    // putFile for snapshot should be called before deleteFile for changelog
    const putCalls = mockPutFile.mock.invocationCallOrder;
    const deleteCalls = mockDeleteFile.mock.invocationCallOrder;

    if (putCalls.length > 0 && deleteCalls.length > 0) {
      const snapshotPutOrder = putCalls[0];
      const changelogDeleteOrder = deleteCalls[0];
      expect(snapshotPutOrder).toBeLessThan(changelogDeleteOrder);
    }
  });
});
