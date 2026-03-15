import { vi, type Mock } from 'vitest';
import { makeSyncData } from '../helpers/sync-helpers';
import {
  maybeCreateBackups,
  listRemoteBackups,
  BACKUP_FILES,
  __resetForTesting,
} from '../../sync/remote-backups';

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

// Mock crypto (partial)
vi.mock('../../sync/crypto', () => ({
  getCachedSalt: vi.fn(() => 'test-salt'),
  encryptSyncData: vi.fn((_, data) => Promise.resolve(data)),
  createVerifier: vi.fn(() => Promise.resolve('test-verifier')),
  deriveKey: vi.fn(),
  generateSalt: vi.fn(() => 'generated-salt'),
  decryptSyncData: vi.fn((_, data) => Promise.resolve(data)),
  encryptBlob: vi.fn(),
  decryptBlob: vi.fn(),
  encryptEntity: vi.fn(),
  decryptEntity: vi.fn(),
  encryptChangeEntries: vi.fn((_, entries) => Promise.resolve(entries)),
  decryptChangeEntries: vi.fn((_, entries) => Promise.resolve(entries)),
  hasEncryptionKey: vi.fn(() => true),
  getCachedEncryptionKey: vi.fn(() => 'mock-key'),
  cacheEncryptionKey: vi.fn(),
  clearEncryptionKey: vi.fn(),
  checkVerifier: vi.fn(() => Promise.resolve(true)),
}));

// Mock sync-engine (partial — just getLocalSnapshot)
vi.mock('../../sync/sync-engine', async () => {
  const actual = await vi.importActual('../../sync/sync-engine');
  return {
    ...actual,
    getLocalSnapshot: vi.fn(() => Promise.resolve(makeSyncData())),
  };
});

import { getFile, putFile } from '../../sync/github-api';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  localStorage.removeItem('gtd25-backup-hourly-at');
  localStorage.removeItem('gtd25-backup-daily-at');
  localStorage.removeItem('gtd25-backup-weekly-at');
  // Eliminate random jitter delay: Math.random() * 30_000 → 0ms
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockEncKey(): CryptoKey {
  return {} as CryptoKey;
}

describe('maybeCreateBackups — gate', () => {
  it('skips when checked < 15 min ago', async () => {
    const now = Date.now();
    localStorage.setItem('gtd25-backup-hourly-at', String(now));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    // First call passes gate, all tiers fresh → returns quickly
    await maybeCreateBackups('pat', 'repo', mockEncKey());

    // Second call within 15 min should skip at the gate
    mockGetFile.mockClear();
    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).not.toHaveBeenCalled();
  });

  it('proceeds on first call', async () => {
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('new-sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).toHaveBeenCalled();
  });

  it('proceeds after 15 min', async () => {
    // Control Date.now to simulate time passage
    const baseTime = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(baseTime);

    localStorage.setItem('gtd25-backup-hourly-at', String(baseTime));
    localStorage.setItem('gtd25-backup-daily-at', String(baseTime));
    localStorage.setItem('gtd25-backup-weekly-at', String(baseTime));

    // First call — all tiers fresh
    await maybeCreateBackups('pat', 'repo', mockEncKey());

    // Advance time by 16 minutes
    dateNowSpy.mockReturnValue(baseTime + 16 * 60 * 1000);
    mockGetFile.mockClear();
    // Make hourly stale
    localStorage.setItem('gtd25-backup-hourly-at', String(baseTime - 2 * 3600_000));
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });
});

describe('maybeCreateBackups — localStorage staleness', () => {
  it('skips fresh tiers', async () => {
    const now = Date.now();
    localStorage.setItem('gtd25-backup-hourly-at', String(now));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it('includes stale tiers', async () => {
    const now = Date.now();
    localStorage.setItem('gtd25-backup-hourly-at', String(now - 2 * 3600_000));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).toHaveBeenCalledWith('pat', 'repo', BACKUP_FILES.hourly);
  });

  it('includes missing-timestamp tiers', async () => {
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockGetFile).toHaveBeenCalledTimes(3);
  });
});

describe('maybeCreateBackups — remote freshness', () => {
  it('skips when remote backedUpAt is fresh', async () => {
    const now = Date.now();
    localStorage.setItem('gtd25-backup-hourly-at', String(now - 2 * 3600_000));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    mockGetFile.mockResolvedValue({
      data: JSON.stringify({ backedUpAt: now - 30 * 60_000 }),
      sha: 'remote-sha',
    });

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it('updates local timestamp when skipping due to remote freshness', async () => {
    const now = Date.now();
    const remoteBackedUpAt = now - 30 * 60_000;
    localStorage.setItem('gtd25-backup-hourly-at', String(now - 2 * 3600_000));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    mockGetFile.mockResolvedValue({
      data: JSON.stringify({ backedUpAt: remoteBackedUpAt }),
      sha: 'remote-sha',
    });

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(localStorage.getItem('gtd25-backup-hourly-at')).toBe(String(remoteBackedUpAt));
  });

  it('creates when remote is 404', async () => {
    const now = Date.now();
    localStorage.setItem('gtd25-backup-hourly-at', String(now - 2 * 3600_000));
    localStorage.setItem('gtd25-backup-daily-at', String(now));
    localStorage.setItem('gtd25-backup-weekly-at', String(now));

    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('new-sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockPutFile).toHaveBeenCalledTimes(1);
    expect(mockPutFile).toHaveBeenCalledWith(
      'pat', 'repo', BACKUP_FILES.hourly,
      expect.any(String),
      undefined,
    );
  });
});

describe('maybeCreateBackups — write', () => {
  it('calls putFile with encrypted data', async () => {
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    expect(mockPutFile).toHaveBeenCalled();
    const putCall = mockPutFile.mock.calls[0];
    const content = JSON.parse(putCall[3]);
    expect(content.backedUpAt).toBeGreaterThan(0);
  });

  it('updates localStorage on success', async () => {
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    const hourlyAt = localStorage.getItem('gtd25-backup-hourly-at');
    expect(hourlyAt).toBeTruthy();
    expect(parseInt(hourlyAt!, 10)).toBeGreaterThan(0);
  });

  it('does NOT update localStorage on putFile failure', async () => {
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockRejectedValue(new Error('CONFLICT'));

    await maybeCreateBackups('pat', 'repo', mockEncKey());
    const hourlyAt = localStorage.getItem('gtd25-backup-hourly-at');
    expect(hourlyAt).toBeFalsy();
  });
});

describe('listRemoteBackups', () => {
  it('returns backedUpAt for existing tiers', async () => {
    const now = Date.now();
    mockGetFile.mockImplementation((_pat: string, _repo: string, path: string) => {
      if (path === BACKUP_FILES.hourly) {
        return Promise.resolve({ data: JSON.stringify({ backedUpAt: now - 1000 }), sha: 'sha1' });
      }
      if (path === BACKUP_FILES.daily) {
        return Promise.resolve({ data: JSON.stringify({ backedUpAt: now - 86400_000 }), sha: 'sha2' });
      }
      return Promise.resolve(null);
    });

    const backups = await listRemoteBackups('pat', 'repo');
    expect(backups).toHaveLength(2);
    expect(backups[0].tier).toBe('hourly');
    expect(backups[0].backedUpAt).toBe(now - 1000);
    expect(backups[1].tier).toBe('daily');
  });

  it('skips 404 tiers', async () => {
    mockGetFile.mockResolvedValue(null);
    const backups = await listRemoteBackups('pat', 'repo');
    expect(backups).toEqual([]);
  });

  it('skips corrupted JSON', async () => {
    mockGetFile.mockResolvedValue({ data: 'not json {{{', sha: 'sha' });
    const backups = await listRemoteBackups('pat', 'repo');
    expect(backups).toEqual([]);
  });

  it('returns empty when none exist', async () => {
    mockGetFile.mockResolvedValue(null);
    const backups = await listRemoteBackups('pat', 'repo');
    expect(backups).toEqual([]);
  });
});
