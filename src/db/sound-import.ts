import { db } from './index';
import { ALL_SOUND_CODES } from '../lib/pomodoro-sounds';

export interface ImportResult {
  imported: string[];
  missing: string[];
}

export async function importSoundsFromZip(file: File): Promise<ImportResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  const imported: string[] = [];

  // Scan for m4a and mp3 files in the zip (including nested paths)
  const entries = Object.entries(zip.files).filter(
    ([name, entry]) => !entry.dir && /\.(m4a|mp3)$/i.test(name),
  );

  for (const [name, entry] of entries) {
    // Extract stem: strip directory prefix and extension
    const basename = name.split('/').pop() ?? name;
    const stem = basename.replace(/\.(m4a|mp3)$/i, '');

    const data = await entry.async('arraybuffer');
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
