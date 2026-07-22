import { db } from './index';
import type { TaskList, Task, Subtask, Settings, PomodoroSettings, SoundPreset, MindmapFolder, Mindmap, MindmapNode } from './models';
import type JSZip from 'jszip';
import { generateSalt, deriveKey, encryptBlob, decryptBlob, createVerifier, checkVerifier } from '../sync/crypto';
import { MAX_MINDMAP_LABEL_LENGTH } from '../lib/constants';

export interface ImportData {
  taskLists: TaskList[];
  tasks: Task[];
  subtasks: Subtask[];
  // Mindmaps (export v3+). Absent on older backups ⇒ local mindmaps are preserved.
  mindmapFolders?: MindmapFolder[];
  mindmaps?: Mindmap[];
  mindmapNodes?: MindmapNode[];
  settings?: Settings;
  pomodoroSettings?: PomodoroSettings;
  soundPresets?: SoundPreset[];
}

const CURRENT_EXPORT_VERSION = 3;
const EXPORT_FORMAT = 'gtd25-export';
const PBKDF2_ITERATIONS = 600_000;

// Resource limits for import — reject malicious/accidental oversized archives before
// they can exhaust memory/CPU (ACR-011). Generous enough for any real backup.
const MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024;   // the .zip on disk
const MAX_DECODED_BYTES = 80 * 1024 * 1024;      // data.json / decrypted payload string
const MAX_RECORDS_PER_ARRAY = 200_000;           // tasks / subtasks / lists / presets

export type ExportKeySource = 'passphrase' | 'sync';

// Plaintext manifest for an encrypted export. Holds only non-sensitive metadata
// needed to derive the key and validate the password; the actual data is in the
// `data.enc` blob.
export interface EncryptedManifest {
  format: typeof EXPORT_FORMAT;
  encrypted: true;
  exportVersion: number;
  exportedAt: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  salt: string;
  verifier: string;
  keySource: ExportKeySource;
}

interface ExportPayload {
  exportVersion: number;
  exportedAt: number;
  taskLists: TaskList[];
  tasks: Task[];
  subtasks: Subtask[];
  mindmapFolders?: MindmapFolder[];
  mindmaps?: Mindmap[];
  mindmapNodes?: MindmapNode[];
  settings: Settings;
  pomodoroSettings?: PomodoroSettings;
  soundPresets?: SoundPreset[];
}

export interface ExportOptions {
  encrypt?: { password: string; keySource: ExportKeySource };
}

export interface ImportOptions {
  // Sync password to try automatically (used when keySource === 'sync').
  syncPassword?: string;
  // Prompt the user for a passphrase. Called only when the encrypted backup
  // can't be opened with `syncPassword`. Return null to cancel.
  getPassword?: (manifest: EncryptedManifest) => Promise<string | null>;
}

async function buildPayload(): Promise<ExportPayload> {
  const [taskLists, tasks, subtasks, mindmapFolders, mindmaps, mindmapNodes, pomodoroSettings, soundPresets] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.toArray(),
    db.subtasks.toArray(),
    db.mindmapFolders.toArray(),
    db.mindmaps.toArray(),
    db.mindmapNodes.toArray(),
    db.pomodoroSettings.get('pomodoro'),
    db.soundPresets.toArray(),
  ]);

  const settings: Settings = {
    theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system',
  };

  return {
    exportVersion: CURRENT_EXPORT_VERSION,
    exportedAt: Date.now(),
    taskLists,
    tasks,
    subtasks,
    mindmapFolders,
    mindmaps,
    mindmapNodes,
    settings,
    pomodoroSettings: pomodoroSettings ?? undefined,
    soundPresets: soundPresets.length > 0 ? soundPresets : undefined,
  };
}

export async function exportToZip(opts?: ExportOptions): Promise<Blob> {
  return packageZip(await buildPayload(), opts);
}

/**
 * Package arbitrary ImportData as a backup zip — same container the exporter
 * writes, so the file can be imported anywhere the app runs. Used to make the
 * device-local safety backups portable; fields the source doesn't carry are
 * left absent, which the importer reads as "keep what this device already has".
 */
export async function zipImportData(data: ImportData, exportedAt: number, opts?: ExportOptions): Promise<Blob> {
  return packageZip({
    ...data,
    exportVersion: CURRENT_EXPORT_VERSION,
    exportedAt,
    settings: data.settings ?? { theme: 'system' },
  }, opts);
}

async function packageZip(payload: ExportPayload, opts?: ExportOptions): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  if (opts?.encrypt) {
    const { password, keySource } = opts.encrypt;
    if (!password) throw new Error('A password is required to encrypt the backup');
    const salt = generateSalt();
    const key = await deriveKey(password, salt);
    const manifest: EncryptedManifest = {
      format: EXPORT_FORMAT,
      encrypted: true,
      exportVersion: CURRENT_EXPORT_VERSION,
      exportedAt: payload.exportedAt,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
      salt,
      verifier: await createVerifier(key),
      keySource,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('data.enc', await encryptBlob(key, JSON.stringify(payload)));
  } else {
    zip.file('data.json', JSON.stringify(payload, null, 2));
  }

  return zip.generateAsync({ type: 'blob' });
}

export async function parseImportZip(file: File, opts?: ImportOptions): Promise<ImportData> {
  if (file.size > MAX_IMPORT_ZIP_BYTES) {
    throw new Error('Invalid backup: file is too large');
  }
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  const dataFile = zip.file('data.json');
  if (dataFile) {
    const raw = await dataFile.async('string');
    if (raw.length > MAX_DECODED_BYTES) throw new Error('Invalid backup: data.json is too large');
    let parsed: ExportPayload;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid backup: data.json is not valid JSON');
    }
    return validatePayload(parsed);
  }

  // Encrypted container
  const manifestFile = zip.file('manifest.json');
  if (manifestFile) {
    const parsed = await decryptPayload(zip, await manifestFile.async('string'), opts);
    return validatePayload(parsed);
  }

  throw new Error('Invalid backup: missing data.json');
}

async function decryptPayload(
  zip: JSZip,
  manifestRaw: string,
  opts?: ImportOptions,
): Promise<ExportPayload> {
  let manifest: EncryptedManifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    throw new Error('Invalid backup: manifest.json is not valid JSON');
  }
  if (manifest.format !== EXPORT_FORMAT || !manifest.encrypted || !manifest.salt || !manifest.verifier) {
    throw new Error('Invalid backup: unrecognized encrypted backup');
  }

  const encFile = zip.file('data.enc');
  if (!encFile) throw new Error('Invalid backup: missing data.enc');
  const cipher = await encFile.async('string');
  if (cipher.length > MAX_DECODED_BYTES) throw new Error('Invalid backup: encrypted data is too large');

  // Resolve a key: try the sync password first when the backup was encrypted
  // with it, otherwise prompt. A wrong password is caught by the verifier.
  let key: CryptoKey | null = null;
  if (manifest.keySource === 'sync' && opts?.syncPassword) {
    const candidate = await deriveKey(opts.syncPassword, manifest.salt);
    if (await checkVerifier(candidate, manifest.verifier)) key = candidate;
  }
  if (!key) {
    if (!opts?.getPassword) {
      throw new Error('Invalid backup: this backup is encrypted; a password is required');
    }
    const entered = await opts.getPassword(manifest);
    if (entered == null) throw new Error('Import cancelled');
    const candidate = await deriveKey(entered, manifest.salt);
    if (!(await checkVerifier(candidate, manifest.verifier))) {
      throw new Error('Invalid backup: wrong password');
    }
    key = candidate;
  }

  let decoded: string;
  try {
    decoded = await decryptBlob(key, cipher);
  } catch {
    throw new Error('Invalid backup: could not decrypt data');
  }
  if (decoded.length > MAX_DECODED_BYTES) throw new Error('Invalid backup: decrypted data is too large');
  let parsed: ExportPayload;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('Invalid backup: could not decrypt data');
  }
  return parsed;
}

function validatePayload(parsed: ExportPayload): ImportData {
  if (!parsed.exportVersion) {
    throw new Error('Invalid backup: missing exportVersion');
  }

  if (parsed.exportVersion > CURRENT_EXPORT_VERSION) {
    throw new Error('This backup was created by a newer version of the app');
  }

  if (!Array.isArray(parsed.taskLists) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.subtasks)) {
    throw new Error('Invalid backup: missing taskLists, tasks, or subtasks arrays');
  }

  // Bound record counts so a crafted backup can't pin the CPU validating millions of
  // entries or blow up IndexedDB (ACR-011).
  if (parsed.taskLists.length > MAX_RECORDS_PER_ARRAY
    || parsed.tasks.length > MAX_RECORDS_PER_ARRAY
    || parsed.subtasks.length > MAX_RECORDS_PER_ARRAY
    || (Array.isArray(parsed.mindmapFolders) && parsed.mindmapFolders.length > MAX_RECORDS_PER_ARRAY)
    || (Array.isArray(parsed.mindmaps) && parsed.mindmaps.length > MAX_RECORDS_PER_ARRAY)
    || (Array.isArray(parsed.mindmapNodes) && parsed.mindmapNodes.length > MAX_RECORDS_PER_ARRAY)
    || (Array.isArray(parsed.soundPresets) && parsed.soundPresets.length > MAX_RECORDS_PER_ARRAY)) {
    throw new Error('Invalid backup: too many records');
  }

  const VALID_TASK_STATUSES = new Set(['todo', 'done', 'blocked']);
  const VALID_LIST_TYPES = new Set(['tasks', 'follow-ups']);
  const warnings: string[] = [];

  // Old backups may carry the removed legacy 'working' status — import them as
  // 'todo' rather than skipping the rows (genuinely garbage statuses still skip).
  parsed.tasks = parsed.tasks.map((t) => ((t.status as string) === 'working' ? { ...t, status: 'todo' as const } : t));
  parsed.subtasks = parsed.subtasks.map((s) => ((s.status as string) === 'working' ? { ...s, status: 'todo' as const } : s));

  function isValidNumber(v: unknown): v is number {
    return typeof v === 'number' && !isNaN(v);
  }

  // Validate task lists
  const validLists = parsed.taskLists.filter((l) => {
    if (!l.id || typeof l.id !== 'string') { warnings.push(`Skipped list without valid id`); return false; }
    if (!l.name || typeof l.name !== 'string') { warnings.push(`Skipped list ${l.id}: missing name`); return false; }
    if (!isValidNumber(l.createdAt) || !isValidNumber(l.updatedAt)) { warnings.push(`Skipped list ${l.id}: invalid timestamps`); return false; }
    if (l.type && !VALID_LIST_TYPES.has(l.type)) { warnings.push(`Skipped list ${l.id}: invalid type "${l.type}"`); return false; }
    return true;
  });

  // Validate tasks
  const validTasks = parsed.tasks.filter((t) => {
    if (!t.id || typeof t.id !== 'string') { warnings.push(`Skipped task without valid id`); return false; }
    if (!t.title || typeof t.title !== 'string') { warnings.push(`Skipped task ${t.id}: missing title`); return false; }
    if (!isValidNumber(t.createdAt) || !isValidNumber(t.updatedAt)) { warnings.push(`Skipped task ${t.id}: invalid timestamps`); return false; }
    if (t.status && !VALID_TASK_STATUSES.has(t.status)) { warnings.push(`Skipped task ${t.id}: invalid status "${t.status}"`); return false; }
    return true;
  });

  // Validate subtasks
  const validSubtasks = parsed.subtasks.filter((s) => {
    if (!s.id || typeof s.id !== 'string') { warnings.push(`Skipped subtask without valid id`); return false; }
    if (!s.title || typeof s.title !== 'string') { warnings.push(`Skipped subtask ${s.id}: missing title`); return false; }
    if (!isValidNumber(s.createdAt) || !isValidNumber(s.updatedAt)) { warnings.push(`Skipped subtask ${s.id}: invalid timestamps`); return false; }
    if (s.status && !VALID_TASK_STATUSES.has(s.status)) { warnings.push(`Skipped subtask ${s.id}: invalid status "${s.status}"`); return false; }
    return true;
  });

  // FK validation: tasks must reference existing lists, subtasks must reference existing tasks
  const validListIds = new Set(validLists.map((l) => l.id));
  const fkValidTasks = validTasks.filter((t) => {
    if (!validListIds.has(t.listId)) {
      warnings.push(`Skipped task ${t.id}: references non-existent list ${t.listId}`);
      return false;
    }
    return true;
  });

  const validTaskIds = new Set(fkValidTasks.map((t) => t.id));
  const fkValidSubtasks = validSubtasks.filter((s) => {
    if (!validTaskIds.has(s.taskId)) {
      warnings.push(`Skipped subtask ${s.id}: references non-existent task ${s.taskId}`);
      return false;
    }
    return true;
  });

  // Validate mindmaps (optional; export v3+). Only distinguish "fields absent"
  // (preserve local mindmaps) from "fields present" (replace) via hasMindmaps.
  const hasMindmaps = parsed.mindmaps !== undefined;
  let validMindmapFolders: MindmapFolder[] | undefined;
  let validMindmaps: Mindmap[] | undefined;
  let validMindmapNodes: MindmapNode[] | undefined;
  if (hasMindmaps) {
    if (!Array.isArray(parsed.mindmaps)
      || (parsed.mindmapFolders !== undefined && !Array.isArray(parsed.mindmapFolders))
      || (parsed.mindmapNodes !== undefined && !Array.isArray(parsed.mindmapNodes))) {
      throw new Error('Invalid backup: malformed mindmap arrays');
    }
    validMindmapFolders = (parsed.mindmapFolders ?? []).filter((f) => {
      if (!f.id || typeof f.id !== 'string') { warnings.push('Skipped mindmap folder without valid id'); return false; }
      if (!f.name || typeof f.name !== 'string') { warnings.push(`Skipped mindmap folder ${f.id}: missing name`); return false; }
      if (!isValidNumber(f.createdAt) || !isValidNumber(f.updatedAt)) { warnings.push(`Skipped mindmap folder ${f.id}: invalid timestamps`); return false; }
      return true;
    });
    validMindmaps = parsed.mindmaps.filter((m) => {
      if (!m.id || typeof m.id !== 'string') { warnings.push('Skipped mindmap without valid id'); return false; }
      if (!m.name || typeof m.name !== 'string') { warnings.push(`Skipped mindmap ${m.id}: missing name`); return false; }
      if (!isValidNumber(m.createdAt) || !isValidNumber(m.updatedAt)) { warnings.push(`Skipped mindmap ${m.id}: invalid timestamps`); return false; }
      return true;
    });
    const validMapIds = new Set(validMindmaps.map((m) => m.id));
    validMindmapNodes = (parsed.mindmapNodes ?? []).filter((n) => {
      if (!n.id || typeof n.id !== 'string') { warnings.push('Skipped mindmap node without valid id'); return false; }
      if (typeof n.label !== 'string' || n.label.length === 0) { warnings.push(`Skipped mindmap node ${n.id}: missing label`); return false; }
      if (!isValidNumber(n.createdAt) || !isValidNumber(n.updatedAt)) { warnings.push(`Skipped mindmap node ${n.id}: invalid timestamps`); return false; }
      if (!n.mapId || typeof n.mapId !== 'string' || !validMapIds.has(n.mapId)) { warnings.push(`Skipped mindmap node ${n.id}: references non-existent map`); return false; }
      return true;
    }).map((n) => (n.label.length > MAX_MINDMAP_LABEL_LENGTH
      ? { ...n, label: n.label.slice(0, MAX_MINDMAP_LABEL_LENGTH) }
      : n));
  }

  // Validate pomodoro settings (optional)
  let validPomodoroSettings: PomodoroSettings | undefined;
  if (parsed.pomodoroSettings) {
    const ps = parsed.pomodoroSettings;
    if (ps.id === 'pomodoro' && isValidNumber(ps.updatedAt) && typeof ps.masterVolume === 'number') {
      validPomodoroSettings = ps;
    } else {
      warnings.push('Skipped pomodoroSettings: invalid shape');
    }
  }

  // Validate sound presets (optional)
  let validSoundPresets: SoundPreset[] | undefined;
  if (Array.isArray(parsed.soundPresets) && parsed.soundPresets.length > 0) {
    validSoundPresets = parsed.soundPresets.filter((sp) => {
      if (!sp.id || typeof sp.id !== 'string') { warnings.push('Skipped sound preset without valid id'); return false; }
      if (!sp.name || typeof sp.name !== 'string') { warnings.push(`Skipped sound preset ${sp.id}: missing name`); return false; }
      if (!isValidNumber(sp.createdAt) || !isValidNumber(sp.updatedAt)) { warnings.push(`Skipped sound preset ${sp.id}: invalid timestamps`); return false; }
      return true;
    });
    if (validSoundPresets.length === 0) validSoundPresets = undefined;
  }

  if (warnings.length > 0) {
    console.warn('Import validation warnings:', warnings);
  }

  return {
    taskLists: validLists,
    tasks: fkValidTasks,
    subtasks: fkValidSubtasks,
    mindmapFolders: validMindmapFolders,
    mindmaps: validMindmaps,
    mindmapNodes: validMindmapNodes,
    settings: parsed.settings,
    pomodoroSettings: validPomodoroSettings,
    soundPresets: validSoundPresets,
  };
}
