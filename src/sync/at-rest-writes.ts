import type { SyncData, Task, TaskList, Subtask, SharedItem } from '../db/models';
import { encryptRow, getActiveAtRestKey, type Row } from '../db/vault-middleware';

type AtRestTableName = 'taskLists' | 'tasks' | 'subtasks' | 'sharedItems';
type AtRestRow = TaskList | Task | Subtask | SharedItem;

export function prepareEntityRowsForAtRest(tableName: 'taskLists', rows: TaskList[]): Promise<TaskList[]>;
export function prepareEntityRowsForAtRest(tableName: 'tasks', rows: Task[]): Promise<Task[]>;
export function prepareEntityRowsForAtRest(tableName: 'subtasks', rows: Subtask[]): Promise<Subtask[]>;
export function prepareEntityRowsForAtRest(tableName: 'sharedItems', rows: SharedItem[]): Promise<SharedItem[]>;
export async function prepareEntityRowsForAtRest(
  tableName: AtRestTableName,
  rows: AtRestRow[],
): Promise<AtRestRow[]> {
  if (rows.length === 0) return rows;
  const key = getActiveAtRestKey();
  if (!key) return rows;

  const encrypted = await Promise.all(
    rows.map((row) => encryptRow(tableName, key, row as unknown as Row)),
  );
  return encrypted as unknown as AtRestRow[];
}

export async function prepareSyncDataForAtRest<T extends Pick<SyncData, 'taskLists' | 'tasks' | 'subtasks'>>(
  data: T,
): Promise<T> {
  const [taskLists, tasks, subtasks] = await Promise.all([
    prepareEntityRowsForAtRest('taskLists', data.taskLists),
    prepareEntityRowsForAtRest('tasks', data.tasks),
    prepareEntityRowsForAtRest('subtasks', data.subtasks),
  ]);

  return { ...data, taskLists, tasks, subtasks };
}
