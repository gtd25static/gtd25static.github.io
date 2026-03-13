import { db } from './index';
import type { TaskList, Task, Subtask, Settings } from './models';

export interface ImportData {
  taskLists: TaskList[];
  tasks: Task[];
  subtasks: Subtask[];
  settings?: Settings;
}

const CURRENT_EXPORT_VERSION = 1;

interface ExportPayload {
  exportVersion: number;
  exportedAt: number;
  taskLists: TaskList[];
  tasks: Task[];
  subtasks: Subtask[];
  settings: Settings;
}

export async function exportToZip(): Promise<Blob> {
  const [taskLists, tasks, subtasks] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.toArray(),
    db.subtasks.toArray(),
  ]);

  const settings: Settings = {
    theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system',
  };

  const payload: ExportPayload = {
    exportVersion: CURRENT_EXPORT_VERSION,
    exportedAt: Date.now(),
    taskLists,
    tasks,
    subtasks,
    settings,
  };

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('data.json', JSON.stringify(payload, null, 2));
  return zip.generateAsync({ type: 'blob' });
}

export async function parseImportZip(file: File): Promise<ImportData> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  const dataFile = zip.file('data.json');
  if (!dataFile) {
    throw new Error('Invalid backup: missing data.json');
  }

  const raw = await dataFile.async('string');
  let parsed: ExportPayload;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid backup: data.json is not valid JSON');
  }

  if (!parsed.exportVersion) {
    throw new Error('Invalid backup: missing exportVersion');
  }

  if (parsed.exportVersion > CURRENT_EXPORT_VERSION) {
    throw new Error('This backup was created by a newer version of the app');
  }

  if (!Array.isArray(parsed.taskLists) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.subtasks)) {
    throw new Error('Invalid backup: missing taskLists, tasks, or subtasks arrays');
  }

  const VALID_TASK_STATUSES = new Set(['todo', 'done', 'blocked', 'working']);
  const VALID_LIST_TYPES = new Set(['tasks', 'follow-ups']);
  const warnings: string[] = [];

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

  if (warnings.length > 0) {
    console.warn('Import validation warnings:', warnings);
  }

  return {
    taskLists: validLists,
    tasks: validTasks,
    subtasks: validSubtasks,
    settings: parsed.settings,
  };
}
