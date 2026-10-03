import JSZip from 'jszip';
import { inflateWithin } from '../../lib/zip-limits';

// A zip bomb: a few KB on disk, gigabytes once inflated. The backup and sound
// imports checked sizes only AFTER inflating everything (threat-model review).

async function entryOf(content: string): Promise<JSZip.JSZipObject> {
  const zip = new JSZip();
  zip.file('data.json', content, { compression: 'DEFLATE' });
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return (await JSZip.loadAsync(bytes)).file('data.json')!;
}

describe('inflateWithin', () => {
  it('returns the bytes of an entry within the limit', async () => {
    const entry = await entryOf('{"ok":true}');
    expect(new TextDecoder().decode(await inflateWithin(entry, 1024, 'too large'))).toBe('{"ok":true}');
  });

  it('refuses an entry whose header admits more than the limit', async () => {
    const entry = await entryOf('a'.repeat(100_000));
    await expect(inflateWithin(entry, 10_000, 'too large')).rejects.toThrow('too large');
  });

  it('stops inflating at the limit even when the header lies', async () => {
    const entry = await entryOf('a'.repeat(200_000));
    (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 10; // a forged header
    await expect(inflateWithin(entry, 10_000, 'too large')).rejects.toThrow('too large');
  });
});

describe('the backup import uses it', () => {
  it('refuses a data.json that inflates past the cap', async () => {
    const { parseImportZip } = await import('../../db/export-import');
    const zip = new JSZip();
    zip.file('data.json', ' '.repeat(81 * 1024 * 1024), { compression: 'DEFLATE' });
    const bytes = (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
    await expect(parseImportZip(bytes)).rejects.toThrow(/too large/);
  }, 60_000);
});

describe('the backup import keeps style values in check', () => {
  it('drops a mindmap background that is not a #rrggbb colour', async () => {
    const { parseImportZip } = await import('../../db/export-import');
    const zip = new JSZip();
    const now = Date.now();
    zip.file('data.json', JSON.stringify({
      exportVersion: 3, exportedAt: now, taskLists: [], tasks: [], subtasks: [],
      mindmapFolders: [],
      mindmaps: [
        { id: 'm1', name: 'Bad', createdAt: now, updatedAt: now, order: 0, background: 'url(data:image/png;base64,AAAA)' },
        { id: 'm2', name: 'Good', createdAt: now, updatedAt: now, order: 1, background: '#aabbcc' },
      ],
      mindmapNodes: [],
    }));
    const bytes = (await zip.generateAsync({ type: 'uint8array' })) as unknown as File;
    const data = await parseImportZip(bytes);
    const byId = new Map((data.mindmaps ?? []).map((m) => [m.id, m]));
    expect('background' in byId.get('m1')!).toBe(false);
    expect(byId.get('m2')!.background).toBe('#aabbcc');
  });
});
