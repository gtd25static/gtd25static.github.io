import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createLocalBackup, readLocalBackup } from '../../db/backup';
import { parseImportZip, zipImportData } from '../../db/export-import';
import type { Task, TaskList } from '../../db/models';

// The test localStorage polyfill doesn't enumerate keys via Object.keys;
// use the index API (same as the paranoid-no-backups test).
function localBackupKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('gtd25-local-backup-')) keys.push(k);
  }
  return keys;
}

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('readLocalBackup', () => {
  it('round-trips a created safety backup as ImportData arrays', async () => {
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    await createLocalBackup();
    const [key] = localBackupKeys();
    expect(key).toBeDefined();

    const data = readLocalBackup(key);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('t1');
    expect(Array.isArray(data.taskLists)).toBe(true);
    expect(Array.isArray(data.subtasks)).toBe(true);
  });

  it('throws when the backup key does not exist', () => {
    expect(() => readLocalBackup('gtd25-local-backup-0')).toThrow('Backup not found');
  });

  it('throws a descriptive error on corrupt JSON', () => {
    localStorage.setItem('gtd25-local-backup-1', '{"taskLists": [trunc');
    expect(() => readLocalBackup('gtd25-local-backup-1')).toThrow('corrupted');
  });

  it('throws on a structurally invalid backup instead of handing it to a restore', () => {
    localStorage.setItem('gtd25-local-backup-1', JSON.stringify({ taskLists: null, tasks: [], subtasks: [] }));
    expect(() => readLocalBackup('gtd25-local-backup-1')).toThrow('invalid');
  });
});

describe('downloading a safety backup', () => {
  it('packages one into a zip the importer accepts on another device', async () => {
    const now = Date.now();
    await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList);
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'Ship it', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    await createLocalBackup();
    const [key] = localBackupKeys();

    const blob = await zipImportData(readLocalBackup(key), now);
    // JSZip in Node can't read a native File/Blob — hand it the bytes
    // (same shim as export-import.test.ts)
    const bytes = new Uint8Array(await blob.arrayBuffer()) as unknown as File;
    const imported = await parseImportZip(bytes);

    expect(imported.taskLists.map((l) => l.id)).toEqual(['l1']);
    expect(imported.tasks.map((t) => t.title)).toEqual(['Ship it']);
    // A safety backup carries no mindmaps — absent, not empty, so importing it
    // elsewhere leaves that device's mindmaps alone.
    expect(imported.mindmaps).toBeUndefined();
  });
});
