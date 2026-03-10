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

  // Validate all items have an id
  const allItems = [...parsed.taskLists, ...parsed.tasks, ...parsed.subtasks];
  for (const item of allItems) {
    if (!item.id) {
      throw new Error('Invalid backup: found item without id field');
    }
  }

  return {
    taskLists: parsed.taskLists,
    tasks: parsed.tasks,
    subtasks: parsed.subtasks,
    settings: parsed.settings,
  };
}
