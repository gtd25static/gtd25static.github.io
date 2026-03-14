import { resetDb } from '../helpers/db-helpers';
import { importSoundsFromZip } from '../../db/sound-import';
import { db } from '../../db';
import { ALL_SOUND_CODES } from '../../lib/pomodoro-sounds';
import JSZip from 'jszip';

// JSZip in Node can't read native File/Blob — generate as Uint8Array
// and cast to File for importSoundsFromZip's type signature
async function makeTestZip(files: Record<string, Uint8Array>): Promise<File> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    zip.file(name, data);
  }
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf as unknown as File;
}

describe('importSoundsFromZip', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('imports m4a files from zip and stores as blobs', async () => {
    const fakeAudio = new Uint8Array([0xff, 0xd8, 0x00, 0x01]);
    const zipFile = await makeTestZip({
      'aa.m4a': fakeAudio,
      'ab.m4a': fakeAudio,
    });

    const result = await importSoundsFromZip(zipFile);

    expect(result.imported).toContain('aa');
    expect(result.imported).toContain('ab');
    expect(result.imported).toHaveLength(2);

    const stored = await db.pomodoroSounds.get('aa');
    expect(stored).toBeDefined();
    expect(stored!.blob).toBeInstanceOf(Blob);
    expect(stored!.importedAt).toBeGreaterThan(0);
  });

  it('imports mp3 files from zip', async () => {
    const fakeAudio = new Uint8Array([0xff, 0xfb]);
    const zipFile = await makeTestZip({
      'ticking-fast.mp3': fakeAudio,
      'alarm-kitchen.mp3': fakeAudio,
    });

    const result = await importSoundsFromZip(zipFile);

    expect(result.imported).toContain('ticking-fast');
    expect(result.imported).toContain('alarm-kitchen');

    const stored = await db.pomodoroSounds.get('ticking-fast');
    expect(stored).toBeDefined();
    expect(stored!.blob.type).toBe('audio/mpeg');
  });

  it('reports missing sounds correctly', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    const zipFile = await makeTestZip({
      'aa.m4a': fakeAudio,
    });

    const result = await importSoundsFromZip(zipFile);

    expect(result.imported).toEqual(['aa']);
    // All codes except 'aa' should be missing
    expect(result.missing).toHaveLength(ALL_SOUND_CODES.length - 1);
    expect(result.missing).not.toContain('aa');
    expect(result.missing).toContain('ab');
    expect(result.missing).toContain('ticking-fast');
  });

  it('handles nested directory paths in zip', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    const zipFile = await makeTestZip({
      'sounds/aa.m4a': fakeAudio,
      'sounds/subdir/ab.m4a': fakeAudio,
    });

    const result = await importSoundsFromZip(zipFile);

    expect(result.imported).toContain('aa');
    expect(result.imported).toContain('ab');
  });

  it('upserts on re-import', async () => {
    const audio1 = new Uint8Array([0x01]);
    const audio2 = new Uint8Array([0x02]);

    const zip1 = await makeTestZip({ 'aa.m4a': audio1 });
    await importSoundsFromZip(zip1);
    const first = await db.pomodoroSounds.get('aa');

    const zip2 = await makeTestZip({ 'aa.m4a': audio2 });
    await importSoundsFromZip(zip2);
    const second = await db.pomodoroSounds.get('aa');

    expect(second!.importedAt).toBeGreaterThanOrEqual(first!.importedAt);
    // Should still be just one record
    const all = await db.pomodoroSounds.where('id').equals('aa').toArray();
    expect(all).toHaveLength(1);
  });

  it('ignores non-audio files in zip', async () => {
    const zipFile = await makeTestZip({
      'readme.txt': new Uint8Array([0x00]),
      'data.json': new Uint8Array([0x00]),
      'aa.m4a': new Uint8Array([0x00]),
    });

    const result = await importSoundsFromZip(zipFile);

    expect(result.imported).toEqual(['aa']);
  });
});
