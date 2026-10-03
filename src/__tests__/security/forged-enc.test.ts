import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass, encryptRow, decryptRow } from '../../db/vault-middleware';
import { enableParanoid, rekeyVault, __resetVaultStateForTests } from '../../db/vault';
import { decryptChangeEntries, decryptSyncData, encryptEntity } from '../../sync/crypto';
import { applyRemoteEntries } from '../../sync/change-log';
import { mergeEntity } from '../../sync/field-timestamps';
import { parseImportZip } from '../../db/export-import';
import type { ChangeEntry, SyncData, Task, TaskList } from '../../db/models';

// A backend writer (a PAT, no sync password) could make a Paranoid device keep
// its real content in plaintext at rest: an upsert whose `_enc` is not a string
// skipped decryption, the field merge copied `_enc` onto the decrypted local row
// (newer timestamp), and the at-rest layer then took any truthy `_enc` for
// "already encrypted" and wrote the row verbatim. Re-key and the secondary
// passphrase then broke on that row. Every layer of that chain is pinned here.

const PASS = 'forged enc passphrase 7 harbor';
const SECRET = 'FIRE_THE_CFO';

async function syncKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function seed() {
  await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { name: 1 } } as TaskList);
  await db.tasks.add({
    id: 't1', listId: 'l1', title: `${SECRET} on Monday`, description: 'board memo', status: 'todo',
    order: 0, createdAt: 1, updatedAt: 1, fieldTimestamps: { title: 1, description: 1 },
  } as Task);
}

async function rawTask(id: string): Promise<Record<string, unknown> | undefined> {
  setMigrationBypass(true);
  try {
    return (await db.tasks.get(id)) as unknown as Record<string, unknown> | undefined;
  } finally {
    setMigrationBypass(false);
  }
}

function forgedUpsert(encValue: unknown): ChangeEntry {
  return {
    id: 'evil-1', deviceId: 'someone-else', timestamp: Date.now(), entityType: 'task', entityId: 't1',
    operation: 'upsert', v: 8,
    data: {
      id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 0, createdAt: 1, updatedAt: 1,
      _enc: encValue, fieldTimestamps: { _enc: 9e15 },
    },
  };
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

describe('a forged `_enc` from the backend', () => {
  for (const encValue of [1, true, {}, ['x']]) {
    it(`(${JSON.stringify(encValue)}) never leaves content in plaintext at rest`, async () => {
      await seed();
      await enableParanoid(PASS);
      const key = await syncKey();

      const entries = await decryptChangeEntries(key, [forgedUpsert(encValue)]);
      await applyRemoteEntries(entries);

      const raw = await rawTask('t1');
      expect(typeof raw?._enc).toBe('string');
      expect(JSON.stringify(raw)).not.toContain(SECRET);
      // …and the device still reads its own content.
      expect((await db.tasks.get('t1'))?.title).toBe(`${SECRET} on Monday`);
    });
  }

  it('cannot break the re-key afterwards', async () => {
    await seed();
    await enableParanoid(PASS);
    await applyRemoteEntries(await decryptChangeEntries(await syncKey(), [forgedUpsert(1)]));
    await expect(rekeyVault(PASS, PASS)).resolves.toBeTruthy();
  });

  it('a malformed changelog entry is dropped, not applied', async () => {
    const out = await decryptChangeEntries(await syncKey(), [forgedUpsert(1)]);
    expect(out).toHaveLength(0);
  });

  it('a snapshot row with a malformed `_enc` is dropped from the snapshot', async () => {
    const key = await syncKey();
    const good = await encryptEntity(key, { id: 't2', listId: 'l1', title: 'ok', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 }, 'task');
    const bad = { id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 0, createdAt: 1, updatedAt: 1, _enc: 1 };
    const data = { taskLists: [], tasks: [good, bad], subtasks: [], settings: { theme: 'system' } } as unknown as SyncData;
    const out = await decryptSyncData(key, data);
    expect(out.tasks.map((t) => t.id)).toEqual(['t2']);
  });
});

describe('the field merge never adopts encryption bookkeeping', () => {
  it('ignores `_enc` and `_decryptError` whatever their timestamps', () => {
    const local = { id: 't1', title: 'mine', updatedAt: 1, fieldTimestamps: { title: 1 } };
    const remote = { id: 't1', title: 'mine', updatedAt: 1, _enc: 'x', _decryptError: true, fieldTimestamps: { _enc: 9e15, _decryptError: 9e15 } };
    const merged = mergeEntity(local, remote, 2);
    expect(merged === null || !('_enc' in merged)).toBe(true);
    expect(merged === null || !('_decryptError' in merged)).toBe(true);
  });
});

describe('the at-rest layer only passes real ciphertext through', () => {
  it('re-encrypts a row that carries plaintext content next to an `_enc`', async () => {
    const key = await syncKey();
    const row = { id: 't1', listId: 'l1', title: SECRET, status: 'todo', _enc: 'stale-or-forged' };
    const out = (await encryptRow('tasks', key, row)) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(typeof out._enc).toBe('string');
    expect(out._enc).not.toBe('stale-or-forged');
  });

  it('re-encrypts a row whose `_enc` is not a string', async () => {
    const key = await syncKey();
    const out = (await encryptRow('tasks', key, { id: 't1', title: SECRET, _enc: true })) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('still passes genuine ciphertext through untouched', async () => {
    const key = await syncKey();
    const enc = await encryptEntity(key, { id: 't1', listId: 'l1', title: SECRET }, 'task');
    expect(await encryptRow('tasks', key, enc)).toBe(enc);
  });

  it('reads a row with a non-string `_enc` as the plaintext it is', async () => {
    const key = await syncKey();
    const out = (await decryptRow('tasks', key, { id: 't1', title: 'plain', _enc: 1 })) as Record<string, unknown>;
    expect(out.title).toBe('plain');
    expect('_enc' in out).toBe(false);
  });

  it('applies the same rules to changelog entries', async () => {
    const key = await syncKey();
    const entry = { id: 'c1', entityType: 'task', operation: 'upsert', data: { id: 't1', title: SECRET, _enc: 1 } };
    const out = (await encryptRow('changeLog', key, entry)) as { data: Record<string, unknown> };
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(typeof out.data._enc).toBe('string');
  });
});

describe('a backup ZIP cannot smuggle `_enc` in', () => {
  it('drops `_enc` and `_decryptError` from imported rows', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('data.json', JSON.stringify({
      exportVersion: 1,
      taskLists: [{ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, _enc: 1 }],
      tasks: [{ id: 't1', listId: 'l1', title: SECRET, status: 'todo', order: 0, createdAt: 1, updatedAt: 1, _enc: true, _decryptError: true }],
      subtasks: [],
    }));
    // JSZip reads a Uint8Array where a File would come from the picker (node has no FileReader).
    const bytes = (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
    const data = await parseImportZip(bytes);
    const task = data.tasks[0] as unknown as Record<string, unknown>;
    const list = data.taskLists[0] as unknown as Record<string, unknown>;
    expect(task.title).toBe(SECRET);
    expect('_enc' in task).toBe(false);
    expect('_decryptError' in task).toBe(false);
    expect('_enc' in list).toBe(false);
  });
});
