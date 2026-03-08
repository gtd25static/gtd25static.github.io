import {
  generateSalt,
  deriveKey,
  encryptBlob,
  decryptBlob,
  encryptEntity,
  decryptEntity,
  encryptSyncData,
  decryptSyncData,
  encryptChangeEntries,
  decryptChangeEntries,
  createVerifier,
  checkVerifier,
} from '../../sync/crypto';
import type { SyncData, ChangeEntry } from '../../db/models';

// Use low iterations for fast tests
const TEST_PASSWORD = 'test-password-123';
let testKey: CryptoKey;
let testSalt: string;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey(TEST_PASSWORD, testSalt);
});

describe('encryptBlob / decryptBlob', () => {
  it('roundtrips a string', async () => {
    const original = 'Hello, World!';
    const encrypted = await encryptBlob(testKey, original);
    const decrypted = await decryptBlob(testKey, encrypted);
    expect(decrypted).toBe(original);
  });

  it('roundtrips empty string', async () => {
    const encrypted = await encryptBlob(testKey, '');
    const decrypted = await decryptBlob(testKey, encrypted);
    expect(decrypted).toBe('');
  });

  it('roundtrips unicode', async () => {
    const original = 'Ångström — 日本語 — 🔒';
    const encrypted = await encryptBlob(testKey, original);
    const decrypted = await decryptBlob(testKey, encrypted);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext each call (random IV)', async () => {
    const plaintext = 'same input';
    const a = await encryptBlob(testKey, plaintext);
    const b = await encryptBlob(testKey, plaintext);
    expect(a).not.toBe(b);
  });

  it('throws with wrong key', async () => {
    const wrongSalt = generateSalt();
    const wrongKey = await deriveKey('wrong-password', wrongSalt);
    const encrypted = await encryptBlob(testKey, 'secret');
    await expect(decryptBlob(wrongKey, encrypted)).rejects.toThrow();
  });
});

describe('encryptEntity / decryptEntity', () => {
  it('strips sensitive fields and adds _enc for task', async () => {
    const task = {
      id: 'task1',
      listId: 'list1',
      title: 'My Task',
      description: 'Some desc',
      link: 'https://example.com',
      linkTitle: 'Example',
      status: 'todo',
      order: 0,
      createdAt: 1000,
      updatedAt: 1001,
    };

    const encrypted = await encryptEntity(testKey, task, 'task');

    // Should have _enc
    expect(encrypted._enc).toBeDefined();
    expect(typeof encrypted._enc).toBe('string');

    // Sensitive fields should be removed
    expect(encrypted.title).toBeUndefined();
    expect(encrypted.description).toBeUndefined();
    expect(encrypted.link).toBeUndefined();
    expect(encrypted.linkTitle).toBeUndefined();

    // Metadata should remain
    expect(encrypted.id).toBe('task1');
    expect(encrypted.listId).toBe('list1');
    expect(encrypted.status).toBe('todo');
    expect(encrypted.order).toBe(0);
    expect(encrypted.createdAt).toBe(1000);
    expect(encrypted.updatedAt).toBe(1001);
  });

  it('roundtrips a task with all fields', async () => {
    const task = {
      id: 'task1',
      listId: 'list1',
      title: 'My Task',
      description: 'Details here',
      link: 'https://example.com',
      linkTitle: 'Example',
      status: 'todo',
      order: 0,
      createdAt: 1000,
      updatedAt: 1001,
    };

    const encrypted = await encryptEntity(testKey, task, 'task');
    const decrypted = await decryptEntity(testKey, encrypted, 'task');
    expect(decrypted).toEqual(task);
  });

  it('roundtrips a taskList', async () => {
    const list = {
      id: 'list1',
      name: 'My List',
      type: 'tasks',
      order: 0,
      createdAt: 1000,
      updatedAt: 1001,
    };

    const encrypted = await encryptEntity(testKey, list, 'taskList');
    expect(encrypted.name).toBeUndefined();
    expect(encrypted._enc).toBeDefined();

    const decrypted = await decryptEntity(testKey, encrypted, 'taskList');
    expect(decrypted).toEqual(list);
  });

  it('roundtrips a subtask', async () => {
    const subtask = {
      id: 'sub1',
      taskId: 'task1',
      title: 'Sub Item',
      link: 'https://link.com',
      linkTitle: 'Link',
      status: 'todo',
      order: 0,
      createdAt: 1000,
      updatedAt: 1001,
    };

    const encrypted = await encryptEntity(testKey, subtask, 'subtask');
    expect(encrypted.title).toBeUndefined();

    const decrypted = await decryptEntity(testKey, encrypted, 'subtask');
    expect(decrypted).toEqual(subtask);
  });

  it('handles entity with undefined optional sensitive fields', async () => {
    const task = {
      id: 'task1',
      listId: 'list1',
      title: 'Minimal Task',
      status: 'todo',
      order: 0,
      createdAt: 1000,
      updatedAt: 1001,
    };

    const encrypted = await encryptEntity(testKey, task, 'task');
    const decrypted = await decryptEntity(testKey, encrypted, 'task');
    expect(decrypted).toEqual(task);
  });

  it('passes through entity without _enc unchanged', async () => {
    const entity = { id: 'x', name: 'test' };
    const result = await decryptEntity(testKey, entity, 'taskList');
    expect(result).toEqual(entity);
  });
});

describe('encryptSyncData / decryptSyncData', () => {
  it('roundtrips mixed entity types', async () => {
    const data: SyncData = {
      syncVersion: 2,
      taskLists: [
        { id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1001 },
      ],
      tasks: [
        { id: 't1', listId: 'l1', title: 'Do stuff', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1001 },
        { id: 't2', listId: 'l1', title: 'Other', description: 'Details', link: 'https://x.com', linkTitle: 'X', status: 'done', order: 1, createdAt: 1000, updatedAt: 1001 },
      ],
      subtasks: [
        { id: 's1', taskId: 't1', title: 'Sub', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1001 },
      ],
      settings: { theme: 'dark', keyboardShortcuts: {} },
    };

    const encrypted = await encryptSyncData(testKey, data);

    // Verify encryption happened
    const encTask = encrypted.tasks[0] as unknown as Record<string, unknown>;
    expect(encTask._enc).toBeDefined();
    expect(encTask.title).toBeUndefined();

    const decrypted = await decryptSyncData(testKey, encrypted);
    expect(decrypted.taskLists).toEqual(data.taskLists);
    expect(decrypted.tasks).toEqual(data.tasks);
    expect(decrypted.subtasks).toEqual(data.subtasks);
    expect(decrypted.settings).toEqual(data.settings);
    expect(decrypted.syncVersion).toBe(2);
  });
});

describe('encryptChangeEntries / decryptChangeEntries', () => {
  it('encrypts upsert entries and skips delete entries', async () => {
    const entries: ChangeEntry[] = [
      {
        id: 'e1',
        deviceId: 'd1',
        timestamp: 1000,
        entityType: 'task',
        entityId: 't1',
        operation: 'upsert',
        data: { id: 't1', listId: 'l1', title: 'Secret Task', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1001 },
      },
      {
        id: 'e2',
        deviceId: 'd1',
        timestamp: 1001,
        entityType: 'task',
        entityId: 't2',
        operation: 'delete',
      },
    ];

    const encrypted = await encryptChangeEntries(testKey, entries);

    // Upsert entry should be encrypted
    expect(encrypted[0].data!._enc).toBeDefined();
    expect(encrypted[0].data!.title).toBeUndefined();
    expect(encrypted[0].data!.id).toBe('t1'); // metadata preserved

    // Delete entry should be unchanged
    expect(encrypted[1]).toEqual(entries[1]);

    // Roundtrip
    const decrypted = await decryptChangeEntries(testKey, encrypted);
    expect(decrypted[0].data).toEqual(entries[0].data);
    expect(decrypted[1]).toEqual(entries[1]);
  });

  it('skips entries with no data', async () => {
    const entries: ChangeEntry[] = [
      { id: 'e1', deviceId: 'd1', timestamp: 1000, entityType: 'task', entityId: 't1', operation: 'upsert' },
    ];
    const encrypted = await encryptChangeEntries(testKey, entries);
    expect(encrypted[0]).toEqual(entries[0]);
  });
});

describe('createVerifier / checkVerifier', () => {
  it('returns true with correct key', async () => {
    const verifier = await createVerifier(testKey);
    const ok = await checkVerifier(testKey, verifier);
    expect(ok).toBe(true);
  });

  it('returns false with wrong key', async () => {
    const verifier = await createVerifier(testKey);
    const wrongKey = await deriveKey('wrong', generateSalt());
    const ok = await checkVerifier(wrongKey, verifier);
    expect(ok).toBe(false);
  });
});
