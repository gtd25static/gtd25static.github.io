import { db } from '../../db';
import { convertSubtaskToTask, convertTaskToSubtask, lostAsSubtask, deleteSubtask, restoreSubtask } from '../../hooks/use-subtasks';
import { deleteTask, restoreTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';

// Conversions between tasks and subtasks, as the UI runs them: asked first when
// something would be lost, and undoable. The original stays in the Trash.

const UNDO_MS = 8000;

/** A subtask becomes a task at the end of `listId`. Returns the new task's id. */
export async function promoteToTask(subtaskId: string, listId: string): Promise<string | undefined> {
  const taskId = await convertSubtaskToTask(subtaskId, listId);
  if (!taskId) return undefined;
  toast('Promoted to task', 'success', () => {
    void (async () => {
      await restoreSubtask(subtaskId);
      await deleteTask(taskId);
    })();
  }, UNDO_MS);
  return taskId;
}

/** A task becomes a subtask of `parentTaskId`. Returns the new subtask's id. */
export async function makeSubtaskOf(taskId: string, parentTaskId: string): Promise<string | undefined> {
  const task = await db.tasks.get(taskId);
  if (!task) return undefined;
  const lost = lostAsSubtask(task);
  if (lost.length > 0) {
    const what = lost.length === 1 ? lost[0] : `${lost.slice(0, -1).join(', ')} and ${lost.at(-1)}`;
    const ok = await confirmDialog(
      `A subtask has no ${what}: “${task.title}” would lose ${lost.length === 1 ? 'it' : 'them'}. The task stays in the Trash for 30 days.`,
      { confirmLabel: 'Make subtask' },
    );
    if (!ok) return undefined;
  }
  const subtaskId = await convertTaskToSubtask(taskId, parentTaskId);
  if (!subtaskId) return undefined;
  toast('Converted to subtask', 'success', () => {
    void (async () => {
      await restoreTask(taskId);
      await deleteSubtask(subtaskId);
    })();
  }, UNDO_MS);
  return subtaskId;
}
