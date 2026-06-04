import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  setVaultKeyProvider,
  clearVaultKeyProvider,
  setMigrationBypass,
} from '../../db/vault-middleware';
import type { Task, Subtask, TaskList, ChangeEntry } from '../../db/models';

let dek: CryptoKey;

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: 'task-' + Math.random().toString(36).slice(2),
    listId: 'list-1',
    title: 'secret title',
    description: 'secret description',
    status: 'todo',
    order: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Read a row straight off disk (bypass = middleware passthrough, no decrypt). */
async function rawGet<T>(table: 'tasks' | 'subtasks' | 'taskLists' | 'changeLog', id: string): Promise<T | undefined> {
  setMigrationBypass(true);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (db as any)[table].get(id)) as T | undefined;
  } finally {
    setMigrationBypass(false);
  }
}

beforeAll(async () => {
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
});

beforeEach(async () => {
  await resetDb();
  setVaultKeyProvider(() => dek);
});

afterEach(() => {
  clearVaultKeyProvider();
  setMigrationBypass(false);
});

describe('vault-middleware: at-rest encryption', () => {
  it('encrypts sensitive fields on add and decrypts on get', async () => {
    const task = makeTask();
    await db.tasks.add(task);

    const raw = await rawGet<Record<string, unknown>>('tasks', task.id);
    expect(raw?._enc).toBeTruthy();
    expect(raw?.title).toBeUndefined();
    expect(raw?.description).toBeUndefined();
    expect(raw?.status).toBe('todo'); // metadata stays plaintext
    expect(JSON.stringify(raw)).not.toContain('secret');

    const got = await db.tasks.get(task.id);
    expect(got?.title).toBe('secret title');
    expect(got?.description).toBe('secret description');
  });

  it('decrypts on toArray / where().sortBy()', async () => {
    await db.tasks.add(makeTask({ id: 't1', title: 'alpha', order: 2 }));
    await db.tasks.add(makeTask({ id: 't2', title: 'bravo', order: 1 }));

    const all = await db.tasks.toArray();
    expect(all.map((t) => t.title).sort()).toEqual(['alpha', 'bravo']);

    const sorted = await db.tasks.where('listId').equals('list-1').sortBy('order');
    expect(sorted.map((t) => t.title)).toEqual(['bravo', 'alpha']);
  });

  it('partial Table.update() of a sensitive field round-trips without leaking plaintext', async () => {
    const task = makeTask({ id: 'tu', title: 'before' });
    await db.tasks.add(task);
    await db.tasks.update('tu', { title: 'after' });

    const got = await db.tasks.get('tu');
    expect(got?.title).toBe('after');
    expect(got?.status).toBe('todo');

    const raw = await rawGet<Record<string, unknown>>('tasks', 'tu');
    expect(raw?.title).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain('after');
  });

  it('partial update of a non-sensitive field preserves the encrypted fields', async () => {
    await db.tasks.add(makeTask({ id: 'tn', title: 'keepme', description: 'keepdesc' }));
    await db.tasks.update('tn', { status: 'done' });

    const got = await db.tasks.get('tn');
    expect(got?.status).toBe('done');
    expect(got?.title).toBe('keepme');
    expect(got?.description).toBe('keepdesc');
  });

  it('cursor reads via .filter().toArray() return decrypted values', async () => {
    await db.tasks.add(makeTask({ id: 'c1', title: 'live', deletedAt: undefined }));
    await db.tasks.add(makeTask({ id: 'c2', title: 'trashed', deletedAt: Date.now() }));

    const trashed = await db.tasks.filter((t) => !!t.deletedAt).toArray();
    expect(trashed).toHaveLength(1);
    expect(trashed[0].title).toBe('trashed');
  });

  it('cursor reads via .filter().first() return a decrypted value', async () => {
    await db.tasks.add(makeTask({ id: 'w1', title: 'working one', status: 'working' }));
    await db.tasks.add(makeTask({ id: 'w2', title: 'todo one', status: 'todo' }));

    const working = await db.tasks.filter((t) => t.status === 'working').first();
    expect(working?.title).toBe('working one');
  });

  it('cursor reads via .filter().count() work on plaintext metadata', async () => {
    await db.tasks.add(makeTask({ id: 'k1', status: 'done' }));
    await db.tasks.add(makeTask({ id: 'k2', status: 'done' }));
    await db.tasks.add(makeTask({ id: 'k3', status: 'todo' }));

    const doneCount = await db.tasks.filter((t) => t.status === 'done').count();
    expect(doneCount).toBe(2);
  });

  it('handles subtasks and taskLists', async () => {
    const list: TaskList = { id: 'l1', name: 'Secret List', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 };
    const sub: Subtask = { id: 's1', taskId: 't1', title: 'secret sub', status: 'todo', order: 1, createdAt: 1, updatedAt: 1 };
    await db.taskLists.add(list);
    await db.subtasks.add(sub);

    expect((await rawGet<Record<string, unknown>>('taskLists', 'l1'))?.name).toBeUndefined();
    expect((await rawGet<Record<string, unknown>>('subtasks', 's1'))?.title).toBeUndefined();

    expect((await db.taskLists.get('l1'))?.name).toBe('Secret List');
    expect((await db.subtasks.get('s1'))?.title).toBe('secret sub');
  });

  it('encrypts changeLog.data and decrypts on read', async () => {
    const entry: ChangeEntry = {
      id: 'ch1',
      deviceId: 'dev1',
      timestamp: Date.now(),
      entityType: 'task',
      entityId: 'tX',
      operation: 'upsert',
      data: { id: 'tX', title: 'changelog secret', status: 'todo' },
    };
    await db.changeLog.add(entry);

    const raw = await rawGet<ChangeEntry>('changeLog', 'ch1');
    expect((raw?.data as Record<string, unknown>)?._enc).toBeTruthy();
    expect((raw?.data as Record<string, unknown>)?.title).toBeUndefined();

    const got = await db.changeLog.get('ch1');
    expect((got?.data as Record<string, unknown>)?.title).toBe('changelog secret');
  });

  it('leaves delete changeLog entries (no data) untouched', async () => {
    const entry: ChangeEntry = {
      id: 'chd',
      deviceId: 'dev1',
      timestamp: Date.now(),
      entityType: 'task',
      entityId: 'tY',
      operation: 'delete',
    };
    await db.changeLog.add(entry);
    const got = await db.changeLog.get('chd');
    expect(got?.operation).toBe('delete');
    expect(got?.data).toBeUndefined();
  });
});

describe('vault-middleware: passthrough when no key', () => {
  beforeEach(() => {
    clearVaultKeyProvider(); // no DEK -> passthrough
  });

  it('stores plaintext when Paranoid Mode is off', async () => {
    const task = makeTask({ id: 'pt', title: 'plain title' });
    await db.tasks.add(task);

    // No bypass needed; provider returns null so nothing is encrypted.
    const raw = await db.tasks.get('pt');
    expect(raw?.title).toBe('plain title');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((raw as any)?._enc).toBeUndefined();
  });
});
