import { vi } from 'vitest';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createLocalBackup, readLocalBackup, getLocalBackups, adoptLegacyLocalBackups } from '../../db/backup';
import { parseImportZip, zipImportData } from '../../db/export-import';
import type { Task, TaskList, Mindmap, MindmapNode } from '../../db/models';

async function localBackupKeys(): Promise<string[]> {
  return (await getLocalBackups()).map((b) => b.key);
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
    const [key] = await localBackupKeys();
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

    const data = await readLocalBackup((await localBackupKeys())[0]);
    expect(data.mindmaps?.map((m) => m.id)).toEqual(['m1']);
    expect(data.mindmapNodes?.map((n) => n.id)).toEqual(['n1']);
  });

  it('throws when the backup key does not exist', async () => {
    await expect(readLocalBackup('gtd25-local-backup-0')).rejects.toThrow('Backup not found');
  });

  it('throws on a structurally invalid backup instead of handing it to a restore', async () => {
    await db.localBackups.put({ id: 'gtd25-local-backup-1', timestamp: 1, taskLists: null as never, tasks: [], subtasks: [] });
    await expect(readLocalBackup('gtd25-local-backup-1')).rejects.toThrow('invalid');
  });
});

// Reliability review 2026-10-06 (M14): in localStorage — a few MB shared with
// every other key — two copies stopped fitting at ~1,200 tasks, one at ~2,000,
// and each start then evicted the copies that did fit.
describe('safety backups in IndexedDB', () => {
  it('are stored there, whatever room localStorage has left', async () => {
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });

    expect(await createLocalBackup()).toBe(true);

    vi.restoreAllMocks();
    expect(await db.localBackups.count()).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it('copies an older build left in localStorage move over at startup; an unreadable one is dropped', async () => {
    const now = Date.now();
    localStorage.setItem(`gtd25-local-backup-${now}`, JSON.stringify({
      timestamp: now, reason: 'change', taskLists: [], subtasks: [],
      tasks: [{ id: 'old', listId: 'l1', title: 'From before', status: 'todo', order: 0, createdAt: now, updatedAt: now }],
    }));
    localStorage.setItem('gtd25-local-backup-1', '{"taskLists": [trunc');

    await adoptLegacyLocalBackups();

    expect(await localBackupKeys()).toEqual([`gtd25-local-backup-${now}`]);
    expect((await readLocalBackup(`gtd25-local-backup-${now}`)).tasks[0].title).toBe('From before');
    expect((await getLocalBackups())[0].reason).toBe('change');
    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(left.filter((k) => k?.startsWith('gtd25-local-backup-'))).toEqual([]);
  });
});

describe('downloading a safety backup', () => {
  it('packages one into a zip the importer accepts on another device', async () => {
    const now = Date.now();
    await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList);
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'Ship it', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    await createLocalBackup();
    const [key] = await localBackupKeys();

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

describe('safety backups survive app restarts', () => {
  // Only two copies are kept and every app start takes one, so two restarts used
  // to push out the copy taken right before an import / restore / pull.
  async function edit(title: string) {
    const now = Date.now();
    await db.tasks.put({ id: 't', listId: 'l1', title, status: 'todo', order: 0, createdAt: now, updatedAt: now } as Task);
  }

  it('keeps the newest copy taken before a destructive change however many app starts follow', async () => {
    await edit('before import');
    await createLocalBackup(); // before a destructive change (the default)
    const [protectedKey] = await localBackupKeys();
    for (const title of ['start 1', 'start 2', 'start 3']) {
      await new Promise((r) => setTimeout(r, 2));
      await edit(title);
      await createLocalBackup({ reason: 'boot' });
    }
    expect(await localBackupKeys()).toContain(protectedKey);
    expect((await readLocalBackup(protectedKey)).tasks[0].title).toBe('before import');
    expect((await localBackupKeys()).length).toBeLessThanOrEqual(3);
  });

  it('an app start with nothing changed since the newest copy takes no new copy', async () => {
    await edit('unchanged');
    await createLocalBackup({ reason: 'boot' });
    await new Promise((r) => setTimeout(r, 2));
    await createLocalBackup({ reason: 'boot' });
    expect(await localBackupKeys()).toHaveLength(1);
  });
});
