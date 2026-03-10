import { db } from '../../db/index';
import { resetDb } from './db-helpers';
import { __resetForTesting as resetSyncEngine } from '../../sync/sync-engine';
import { __resetForTesting as resetRemoteBackups } from '../../sync/remote-backups';
import { clearEncryptionKey } from '../../sync/crypto';
import type { ChangeEntry } from '../../db/models';
import { newId } from '../../lib/id';

const SYNC_LOCALSTORAGE_KEYS = [
  'gtd25-sync-dirty',
  'gtd25-backup-hourly-at',
  'gtd25-backup-daily-at',
  'gtd25-backup-weekly-at',
  'gtd25-theme',
];

export async function resetSyncState() {
  await resetDb();
  resetSyncEngine();
  resetRemoteBackups();
  clearEncryptionKey();
  for (const key of SYNC_LOCALSTORAGE_KEYS) {
    localStorage.removeItem(key);
  }
}

export async function setupSyncCredentials(overrides?: Partial<{
  syncEnabled: boolean;
  githubPat: string;
  githubRepo: string;
  deviceId: string;
  encryptionPassword: string;
}>) {
  await db.localSettings.update('local', {
    syncEnabled: true,
    githubPat: 'ghp_test123',
    githubRepo: 'user/repo',
    deviceId: 'device-A',
    encryptionPassword: 'test-password',
    ...overrides,
  });
}

export function makeChangeEntry(overrides?: Partial<ChangeEntry>): ChangeEntry {
  return {
    id: newId(),
    deviceId: 'device-A',
    timestamp: Date.now(),
    entityType: 'task',
    entityId: newId(),
    operation: 'upsert',
    data: {
      id: overrides?.entityId ?? newId(),
      listId: 'list-1',
      title: 'Test Task',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

export function makeSyncData(overrides?: Record<string, unknown>) {
  return {
    syncVersion: 2,
    taskLists: [],
    tasks: [],
    subtasks: [],
    settings: { theme: 'system' as const },
    ...overrides,
  };
}
