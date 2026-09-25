import { vi } from 'vitest';
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
import JSZip from 'jszip';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { exportToZip, parseImportZip } from '../../db/export-import';
import { importData } from '../../sync/sync-engine';
import type { SharedItem } from '../../db/models';

// Paranoid Mode tells you to download a recovery backup before disabling or
// wiping, but the export left the Shared Folder out. On a device without sync
// the folder can only hold links (files and snippets need sync, and then live in
// the repository), so the export now carries the links; importing adds them
// without touching this device's files.

const now = Date.now();
const link = (id: string, url: string): SharedItem =>
  ({ id, type: 'link', name: `Link ${id}`, size: url.length, url, order: 0, createdAt: now, updatedAt: now });
const file = (id: string): SharedItem =>
  ({ id, type: 'file', name: `File ${id}`, size: 10, blobId: `b-${id}`, mimeType: 'text/plain', order: 1, createdAt: now, updatedAt: now });

async function zipOf(payload: unknown): Promise<File> {
  const zip = new JSZip();
  zip.file('data.json', JSON.stringify(payload));
  return (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
}

async function exportedPayload(): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(new Uint8Array(await (await exportToZip()).arrayBuffer()));
  return JSON.parse(await zip.file('data.json')!.async('string'));
}

beforeEach(async () => {
  await resetDb();
});

describe('Shared Folder links in the recovery backup', () => {
  it('exports the links, not the files (their bytes live in the sync repository)', async () => {
    await db.sharedItems.bulkPut([link('l1', 'https://example.com/a'), file('f1')]);
    const payload = await exportedPayload();
    expect((payload.sharedLinks as SharedItem[]).map((i) => i.id)).toEqual(['l1']);
    expect(payload.exportVersion).toBe(3); // additive: older app versions still import it
  });

  it('round-trips: importing adds the links and keeps this device\'s files', async () => {
    await db.sharedItems.bulkPut([link('l1', 'https://example.com/a')]);
    const exported = await exportedPayload();
    await resetDb();
    await db.sharedItems.bulkPut([file('mine')]);

    await importData(await parseImportZip(await zipOf(exported)));

    expect((await db.sharedItems.toArray()).map((i) => i.id).sort()).toEqual(['l1', 'mine']);
  });

  it('drops imported links that are not plain http(s) links', async () => {
    const data = await parseImportZip(await zipOf({
      exportVersion: 3, exportedAt: now, taskLists: [], tasks: [], subtasks: [],
      sharedLinks: [
        link('ok', 'https://example.com'),
        link('js', 'javascript:alert(1)'),
        { ...link('file', 'https://example.com'), type: 'file' },
        { id: 'broken' },
      ],
    }));
    expect(data.sharedLinks?.map((i) => i.id)).toEqual(['ok']);
  });

  it('an older backup without links leaves the Shared Folder alone', async () => {
    await db.sharedItems.bulkPut([link('keep', 'https://example.com')]);
    await importData(await parseImportZip(await zipOf({ exportVersion: 3, exportedAt: now, taskLists: [], tasks: [], subtasks: [] })));
    expect((await db.sharedItems.toArray()).map((i) => i.id)).toEqual(['keep']);
  });
});
