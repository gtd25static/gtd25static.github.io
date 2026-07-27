import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createLocalBackup, readLocalBackup } from '../../db/backup';
import { parseImportZip, zipImportData } from '../../db/export-import';
import type { Task, TaskList, Mindmap, MindmapNode } from '../../db/models';

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

    const data = await readLocalBackup(key);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('t1');
    expect(Array.isArray(data.taskLists)).toBe(true);
    expect(Array.isArray(data.subtasks)).toBe(true);
  });

  it('carries mindmaps, so restoring here brings the maps back too', async () => {
    const now = Date.now();
    await db.mindmaps.add({ id: 'm1', name: 'Plan', order: 0, createdAt: now, updatedAt: now } as Mindmap);
    await db.mindmapNodes.add({ id: 'n1', mapId: 'm1', label: 'Root', order: 0, createdAt: now, updatedAt: now } as MindmapNode);
    await createLocalBackup();

    const data = await readLocalBackup(localBackupKeys()[0]);
    expect(data.mindmaps?.map((m) => m.id)).toEqual(['m1']);
    expect(data.mindmapNodes?.map((n) => n.id)).toEqual(['n1']);
  });

  it('throws when the backup key does not exist', async () => {
    await expect(readLocalBackup('gtd25-local-backup-0')).rejects.toThrow('Backup not found');
  });

  it('throws a descriptive error on corrupt JSON', async () => {
    localStorage.setItem('gtd25-local-backup-1', '{"taskLists": [trunc');
    await expect(readLocalBackup('gtd25-local-backup-1')).rejects.toThrow('corrupted');
  });

  it('throws on a structurally invalid backup instead of handing it to a restore', async () => {
    localStorage.setItem('gtd25-local-backup-1', JSON.stringify({ taskLists: null, tasks: [], subtasks: [] }));
    await expect(readLocalBackup('gtd25-local-backup-1')).rejects.toThrow('invalid');
  });
});

describe('downloading a safety backup', () => {
  it('packages one into a zip the importer accepts on another device', async () => {
    const now = Date.now();
    await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList);
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'Ship it', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    await createLocalBackup();
    const [key] = localBackupKeys();

    // The download path strips mindmaps on purpose (see BackupsSettings): a zip
    // carrying `mindmaps: []` would wipe the maps of the device importing it.
    const { mindmapFolders: _f, mindmaps: _m, mindmapNodes: _n, ...portable } = await readLocalBackup(key);
    const blob = await zipImportData(portable, now);
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
