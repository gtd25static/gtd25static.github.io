import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { updateTask } from './use-tasks';

export function revealTask(taskId: string, listId: string): void {
  const app = useAppState.getState();
  app.selectList(listId);
  app.ensureTaskExpanded(taskId);
  app.setNavigateToTaskId(taskId);
}

function maybeStartTimer(startTimer: boolean): void {
  if (startTimer && !usePomodoroStore.getState().timerRunning) {
    usePomodoroStore.getState().startPlus25();
  }
}

/**
 * "Focus on this task": stamp workedAt (first time only — feeds the ×3
 * previously-worked boost in focus/nudge selection), optionally navigate to it,
 * and optionally start a Pomodoro. No status change ('working' was removed).
 */
export async function focusTask(taskId: string, opts?: { startTimer?: boolean; navigate?: boolean }): Promise<void> {
  const task = await db.tasks.get(taskId);
  if (!task || task.deletedAt || task.status === 'done' || task.archived) return;
  if (!task.workedAt) await updateTask(task.id, { workedAt: Date.now() });
  if (opts?.navigate ?? true) revealTask(task.id, task.listId);
  maybeStartTimer(opts?.startTimer ?? false);
}
