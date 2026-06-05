import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, getDEK, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import { getLocalSnapshot } from '../../sync/sync-engine';
import {
  deriveKey, generateSalt, encryptSyncData, decryptSyncData, decryptEntity,
} from '../../sync/crypto';
import type { Task, TaskList } from '../../db/models';

const PASS = 'cross compat passphrase';
const SHARED_SYNC_PW = 'shared-sync-password';

async function rawTask(id: string): Promise<Record<string, unknown> | undefined> {
  // Bypass the middleware to read exactly what is on disk.
  setMigrationBypass(true);
  try {
    return (await db.tasks.get(id)) as unknown as Record<string, unknown> | undefined;
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('paranoid <-> non-paranoid cross-compatibility', () => {
  it('a paranoid device emits a wire payload readable with the sync key alone (no DEK leak)', async () => {
    await db.taskLists.add({ id: 'l1', name: 'List', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 } as TaskList);
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'Top secret', description: 'hidden', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);

    await enableParanoid(PASS); // DEK active; rows now encrypted at rest

    // On disk: DEK-encrypted, no plaintext title.
    const raw = await rawTask('t1');
    expect(raw?._enc).toBeTruthy();
    expect(raw?.title).toBeUndefined();

    // The sync engine reads plaintext (middleware decrypts with the DEK) ...
    const snapshot = await getLocalSnapshot();
    expect(snapshot.tasks[0].title).toBe('Top secret');

    // ... then encrypts the WIRE with the sync key, which is independent of the DEK.
    const salt = generateSalt();
    const syncKey = await deriveKey(SHARED_SYNC_PW, salt);
    const wire = await encryptSyncData(syncKey, snapshot);

    const wireTask = wire.tasks[0] as unknown as Record<string, unknown>;
    expect(wireTask._enc).toBeTruthy();
    expect(wireTask.title).toBeUndefined();   // no plaintext on the wire
    expect(wireTask.listId).toBe('l1');       // non-sensitive metadata stays plaintext

    // A paranoid-OFF puller decrypts with ONLY the sync key.
    const decrypted = await decryptSyncData(syncKey, wire);
    expect(decrypted.tasks[0].title).toBe('Top secret');
    expect(decrypted.tasks[0].description).toBe('hidden');

    // The local DEK must NOT be able to read the wire — proves no DEK layer leaked.
    const dek = getDEK();
    await expect(decryptEntity(dek!, { ...wireTask }, 'task')).rejects.toBeTruthy();
  });

  it('a paranoid device ingests a non-paranoid payload and stores it encrypted at rest', async () => {
    // Wire payload as a paranoid-OFF device would emit it: plaintext rows
    // encrypted with the shared sync key only.
    const salt = generateSalt();
    const syncKey = await deriveKey(SHARED_SYNC_PW, salt);
    const now = Date.now();
    const plainSnapshot = {
      syncVersion: 99,
      taskLists: [{ id: 'l1', name: 'Shared List', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 }],
      tasks: [{ id: 't9', listId: 'l1', title: 'From plain device', status: 'todo', order: 1, createdAt: now, updatedAt: now }],
      subtasks: [],
      settings: { theme: 'system' as const },
    };
    const wire = await encryptSyncData(syncKey, plainSnapshot as never);

    await enableParanoid(PASS); // DEK active

    // Apply the pulled payload the way the sync engine does: sync-key decrypt, then bulkPut.
    const incoming = await decryptSyncData(syncKey, wire);
    await db.taskLists.bulkPut(incoming.taskLists); // middleware encrypts at rest with the DEK
    await db.tasks.bulkPut(incoming.tasks);

    // Readable while unlocked ...
    expect((await db.tasks.get('t9'))?.title).toBe('From plain device');
    // ... DEK-encrypted on disk.
    const raw = await rawTask('t9');
    expect(raw?._enc).toBeTruthy();
    expect(raw?.title).toBeUndefined();
  });
});
