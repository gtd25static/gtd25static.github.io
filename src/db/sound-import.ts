import { db } from './index';
import { ALL_SOUND_CODES } from '../lib/pomodoro-sounds';

export interface ImportResult {
  imported: string[];
  missing: string[];
}

// Resource limits — reject oversized/abusive sound archives before they exhaust
// memory or storage (ACR-011). Generous for a real sound pack.
const MAX_SOUND_ZIP_BYTES = 100 * 1024 * 1024; // the .zip on disk
const MAX_SOUND_FILES = 200;                   // distinct audio entries
const MAX_SOUND_FILE_BYTES = 15 * 1024 * 1024; // one decoded audio file
const MAX_SOUND_TOTAL_BYTES = 150 * 1024 * 1024; // aggregate decoded bytes

export async function importSoundsFromZip(file: File): Promise<ImportResult> {
  if (file.size > MAX_SOUND_ZIP_BYTES) {
    throw new Error('Sound archive is too large');
  }
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  const imported: string[] = [];

  // Scan for m4a and mp3 files in the zip (including nested paths)
  const entries = Object.entries(zip.files).filter(
    ([name, entry]) => !entry.dir && /\.(m4a|mp3)$/i.test(name),
  );
  if (entries.length > MAX_SOUND_FILES) {
    throw new Error(`Too many sound files (max ${MAX_SOUND_FILES})`);
  }

  let totalBytes = 0;
  for (const [name, entry] of entries) {
    // Extract stem: strip directory prefix and extension
    const basename = name.split('/').pop() ?? name;
    const stem = basename.replace(/\.(m4a|mp3)$/i, '');

    const data = await entry.async('arraybuffer');
    if (data.byteLength > MAX_SOUND_FILE_BYTES) {
      throw new Error(`Sound "${basename}" is too large`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_SOUND_TOTAL_BYTES) {
      throw new Error('Sound archive exceeds the total size limit');
    }
    const ext = basename.match(/\.(m4a|mp3)$/i)?.[1]?.toLowerCase() ?? 'm4a';
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    const blob = new Blob([data], { type: mimeType });

    await db.pomodoroSounds.put({
      id: stem,
      blob,
      importedAt: Date.now(),
    });
    imported.push(stem);
  }

  const importedSet = new Set(imported);
  const missing = ALL_SOUND_CODES.filter((code) => !importedSet.has(code));

  return { imported, missing };
}
