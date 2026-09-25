import type { Task, TaskList } from '../../db/models';
import { moveTaskToList, updateTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';

/**
 * "Send to list" between lists of the same type: says where the task went, and
 * Undo puts it back in its old list and place (moving appends it at the end).
 * It used to move the task silently, with no way back.
 */
export async function sendToList(task: Task, target: TaskList): Promise<void> {
  const from = { listId: task.listId, order: task.order };
  if (!(await moveTaskToList(task.id, target.id))) return;
  toast(`Moved to ${target.name}`, 'success', async () => {
    if (await moveTaskToList(task.id, from.listId)) await updateTask(task.id, { order: from.order });
  });
}
