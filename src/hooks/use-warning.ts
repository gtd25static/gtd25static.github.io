import { db } from '../db';
import { updateTask } from './use-tasks';
import { updateSubtask } from './use-subtasks';

export async function toggleWarning(entityType: 'task' | 'subtask', id: string) {
  if (entityType === 'task') {
    const task = await db.tasks.get(id);
    if (!task) return;
    const nowWarning = !task.hasWarning;
    await updateTask(id, {
      hasWarning: nowWarning || undefined,
      warningAt: nowWarning ? Date.now() : undefined,
    });
  } else {
    const subtask = await db.subtasks.get(id);
    if (!subtask) return;
    const nowWarning = !subtask.hasWarning;
    await updateSubtask(id, {
      hasWarning: nowWarning || undefined,
      warningAt: nowWarning ? Date.now() : undefined,
    });
  }
}
