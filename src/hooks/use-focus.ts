import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { startWorkingOn, startWorkingOnTask } from './use-working-on';

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

export async function focusTask(taskId: string, opts?: { startTimer?: boolean; subtaskId?: string }): Promise<void> {
  const startTimer = opts?.startTimer ?? false;
  const task = await db.tasks.get(taskId);
  if (!task || task.deletedAt || task.status === 'done' || task.archived) return;

  const subtasks = await db.subtasks.where('taskId').equals(task.id).sortBy('order');
  const targetSubtask = opts?.subtaskId
    ? subtasks.find((s) => s.id === opts.subtaskId && !s.deletedAt && s.status === 'todo')
    : undefined;
  const firstTodo = targetSubtask ?? subtasks.find((s) => !s.deletedAt && s.status === 'todo');
  if (firstTodo) {
    await startWorkingOn(firstTodo.id);
  } else if (subtasks.some((s) => !s.deletedAt && s.status !== 'done')) {
    revealTask(task.id, task.listId);
    return;
  } else {
    await startWorkingOnTask(task.id);
  }
  revealTask(task.id, task.listId);
  maybeStartTimer(startTimer);
}
