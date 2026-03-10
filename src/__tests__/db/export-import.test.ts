import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { exportToZip, parseImportZip } from '../../db/export-import';
import { newId } from '../../lib/id';
import JSZip from 'jszip';

beforeEach(async () => {
  await resetDb();
  localStorage.removeItem('gtd25-theme');
});

// JSZip in Node can't read native File/Blob — generate as Uint8Array
// and cast to File for parseImportZip's type signature
async function makeTestZip(content: string | null, filename = 'data.json'): Promise<File> {
  const zip = new JSZip();
  if (content !== null) {
    zip.file(filename, content);
  }
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf as unknown as File;
}

// Convert exportToZip Blob to Uint8Array for JSZip compatibility in Node
async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

describe('exportToZip', () => {
  it('produces valid ZIP with data.json', async () => {
    const blob = await exportToZip();
    expect(blob).toBeInstanceOf(Blob);
    const buf = await blobToUint8Array(blob);
    const zip = await JSZip.loadAsync(buf);
    const dataFile = zip.file('data.json');
    expect(dataFile).toBeTruthy();
  });

  it('has exportVersion:1 and exportedAt', async () => {
    const blob = await exportToZip();
    const buf = await blobToUint8Array(blob);
    const zip = await JSZip.loadAsync(buf);
    const raw = await zip.file('data.json')!.async('string');
    const data = JSON.parse(raw);
    expect(data.exportVersion).toBe(1);
    expect(data.exportedAt).toBeGreaterThan(0);
  });

  it('includes all DB records', async () => {
    const listId = newId();
    const taskId = newId();
    const subtaskId = newId();
    const now = Date.now();
    await db.taskLists.add({ id: listId, name: 'My List', type: 'tasks', order: 0, createdAt: now, updatedAt: now });
    await db.tasks.add({ id: taskId, listId, title: 'My Task', status: 'todo', order: 0, createdAt: now, updatedAt: now });
    await db.subtasks.add({ id: subtaskId, taskId, title: 'My Sub', status: 'todo', order: 0, createdAt: now, updatedAt: now });

    const blob = await exportToZip();
    const buf = await blobToUint8Array(blob);
    const zip = await JSZip.loadAsync(buf);
    const data = JSON.parse(await zip.file('data.json')!.async('string'));

    expect(data.taskLists).toHaveLength(1);
    expect(data.taskLists[0].name).toBe('My List');
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe('My Task');
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0].title).toBe('My Sub');
  });

  it('includes theme from localStorage', async () => {
    localStorage.setItem('gtd25-theme', 'dark');
    const blob = await exportToZip();
    const buf = await blobToUint8Array(blob);
    const zip = await JSZip.loadAsync(buf);
    const data = JSON.parse(await zip.file('data.json')!.async('string'));
    expect(data.settings.theme).toBe('dark');
  });

  it('works with empty DB', async () => {
    await db.taskLists.clear();
    await db.tasks.clear();
    await db.subtasks.clear();

    const blob = await exportToZip();
    const buf = await blobToUint8Array(blob);
    const zip = await JSZip.loadAsync(buf);
    const data = JSON.parse(await zip.file('data.json')!.async('string'));
    expect(data.taskLists).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.subtasks).toEqual([]);
  });
});

describe('parseImportZip — validation', () => {
  it('throws on missing data.json', async () => {
    const file = await makeTestZip(null);
    await expect(parseImportZip(file)).rejects.toThrow('Invalid backup: missing data.json');
  });

  it('throws on invalid JSON', async () => {
    const file = await makeTestZip('not valid json {{{');
    await expect(parseImportZip(file)).rejects.toThrow('Invalid backup: data.json is not valid JSON');
  });

  it('throws on missing exportVersion', async () => {
    const file = await makeTestZip(JSON.stringify({
      taskLists: [], tasks: [], subtasks: [],
    }));
    await expect(parseImportZip(file)).rejects.toThrow('Invalid backup: missing exportVersion');
  });

  it('throws on missing arrays', async () => {
    const file = await makeTestZip(JSON.stringify({
      exportVersion: 1,
      taskLists: [],
    }));
    await expect(parseImportZip(file)).rejects.toThrow('Invalid backup: missing taskLists, tasks, or subtasks arrays');
  });

  it('throws on item without id', async () => {
    const file = await makeTestZip(JSON.stringify({
      exportVersion: 1,
      taskLists: [{ name: 'No ID' }],
      tasks: [],
      subtasks: [],
    }));
    await expect(parseImportZip(file)).rejects.toThrow('Invalid backup: found item without id field');
  });

  it('rejects future exportVersion with clear error', async () => {
    const file = await makeTestZip(JSON.stringify({
      exportVersion: 99,
      exportedAt: Date.now(),
      taskLists: [],
      tasks: [],
      subtasks: [],
    }));
    await expect(parseImportZip(file)).rejects.toThrow('This backup was created by a newer version of the app');
  });

  it('error messages start with "Invalid backup:"', async () => {
    const file = await makeTestZip(null);
    try {
      await parseImportZip(file);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/^Invalid backup:/);
    }
  });
});

describe('parseImportZip — valid', () => {
  it('parses all arrays correctly', async () => {
    const now = Date.now();
    const file = await makeTestZip(JSON.stringify({
      exportVersion: 1,
      exportedAt: now,
      taskLists: [{ id: 'l1', name: 'List', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
      tasks: [{ id: 't1', listId: 'l1', title: 'Task', status: 'todo', order: 0, createdAt: now, updatedAt: now }],
      subtasks: [{ id: 's1', taskId: 't1', title: 'Sub', status: 'todo', order: 0, createdAt: now, updatedAt: now }],
      settings: { theme: 'dark' },
    }));
    const result = await parseImportZip(file);
    expect(result.taskLists).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.subtasks).toHaveLength(1);
    expect(result.settings?.theme).toBe('dark');
  });

  it('handles missing settings', async () => {
    const file = await makeTestZip(JSON.stringify({
      exportVersion: 1,
      exportedAt: Date.now(),
      taskLists: [],
      tasks: [],
      subtasks: [],
    }));
    const result = await parseImportZip(file);
    expect(result.settings).toBeUndefined();
  });

  it('roundtrips with exportToZip', async () => {
    const listId = newId();
    const taskId = newId();
    const now = Date.now();
    await db.taskLists.add({ id: listId, name: 'Roundtrip', type: 'tasks', order: 0, createdAt: now, updatedAt: now });
    await db.tasks.add({ id: taskId, listId, title: 'RT Task', status: 'done', order: 0, createdAt: now, updatedAt: now });

    const blob = await exportToZip();
    const buf = await blobToUint8Array(blob);
    const result = await parseImportZip(buf as unknown as File);
    expect(result.taskLists).toHaveLength(1);
    expect(result.taskLists[0].name).toBe('Roundtrip');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('RT Task');
  });
});
