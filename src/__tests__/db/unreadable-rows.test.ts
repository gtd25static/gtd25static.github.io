import { vi } from 'vitest';
import JSZip from 'jszip';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { exportToZip, parseImportZip } from '../../db/export-import';
import { createLocalBackup, getLocalBackups, readLocalBackup } from '../../db/backup';
import type { Task } from '../../db/models';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

// Reliability review 2026-10-06 (M13): a row the vault cannot decrypt is shown
// as a placeholder ("⚠︎ unreadable", `_decryptError`). Exports and safety
// backups read through the vault, so they carried the placeholders; importing
// or restoring stripped the flag and wrote them back as real rows — over the
// intact copies on the remote and every other device.

const now = Date.now();
const good: Task = { id: 'good', listId: 'l1', title: 'Readable', status: 'todo', order: 0, createdAt: now, updatedAt: now };
const placeholder = { id: 'bad', listId: 'l1', title: '⚠︎ unreadable', status: 'todo', order: 1, createdAt: now, updatedAt: now, _decryptError: true } as Task;

beforeEach(async () => {
  await resetDb();
  await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: now, updatedAt: now });
  await db.tasks.bulkAdd([good, placeholder]);
});

async function zipBytes(blob: Blob): Promise<File> {
  return new Uint8Array(await blob.arrayBuffer()) as unknown as File;
}

it('an export leaves out rows this device cannot read', async () => {
  const zip = await JSZip.loadAsync(await zipBytes(await exportToZip()));
  const data = JSON.parse(await zip.file('data.json')!.async('string'));
  expect(data.tasks.map((t: Task) => t.id)).toEqual(['good']);
});

it('an import refuses placeholder rows instead of making them real', async () => {
  const zip = new JSZip();
  zip.file('data.json', JSON.stringify({
    exportVersion: 3, exportedAt: now,
    taskLists: [{ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: now, updatedAt: now }],
    tasks: [good, placeholder], subtasks: [],
  }));
  const parsed = await parseImportZip(await zip.generateAsync({ type: 'uint8array' }) as unknown as File);
  expect(parsed.tasks.map((t) => t.id)).toEqual(['good']);
});

it('a safety backup leaves them out too, with no sync bookkeeping', async () => {
  await db.tasks.update('good', { _base: { title: 1 }, _pushed: { title: 1 } } as never);
  expect(await createLocalBackup()).toBe(true);
  const [latest] = await getLocalBackups();
  const restored = await readLocalBackup(latest.key);
  expect(restored.tasks.map((t) => t.id)).toEqual(['good']);
  expect(JSON.stringify(restored)).not.toContain('_base');
  expect(JSON.stringify(restored)).not.toContain('_pushed');
});
