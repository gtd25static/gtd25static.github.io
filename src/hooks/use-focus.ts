import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { eligibleForFocus, pickWeighted } from '../lib/focus-pick';
import { startWorkingOn, startWorkingOnTask } from './use-working-on';

const TIMER_PREF_KEY = 'gtd25-focus-timer';

export function getFocusTimerPref(): boolean {
  return localStorage.getItem(TIMER_PREF_KEY) === '1';
}

export function setFocusTimerPref(on: boolean): void {
  localStorage.setItem(TIMER_PREF_KEY, on ? '1' : '0');
}

function revealTask(taskId: string, listId: string): void {
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
 * One-click "let's go": resume the current working task if there is one, otherwise pick
 * the weighted next-up task, start working on it, and reveal it. Optionally starts a
 * pomodoro. Safe to call from a button or the keyboard handler.
 */
export async function focusNow(opts?: { startTimer?: boolean }): Promise<void> {
  const startTimer = opts?.startTimer ?? getFocusTimerPref();

  // Already working → resume (navigate to it) rather than picking something new.
  const workingSub = (await db.subtasks.where('status').equals('working').toArray()).find((s) => !s.deletedAt);
  if (workingSub) {
    const task = await db.tasks.get(workingSub.taskId);
    if (task && !task.deletedAt) revealTask(task.id, task.listId);
    maybeStartTimer(startTimer);
    return;
  }
  const workingTask = (await db.tasks.where('status').equals('working').toArray()).find((t) => !t.deletedAt);
  if (workingTask) {
    revealTask(workingTask.id, workingTask.listId);
    maybeStartTimer(startTimer);
    return;
  }

  // Otherwise pick the next-up task and start it.
  const taskLists = await db.taskLists.toArray();
  const taskListIds = new Set(taskLists.filter((l) => !l.deletedAt && l.type === 'tasks').map((l) => l.id));
  const tasks = await db.tasks.toArray();
  const pick = pickWeighted(eligibleForFocus(tasks, taskListIds), Date.now());
  if (!pick) return; // nothing to focus on

  const subtasks = await db.subtasks.where('taskId').equals(pick.id).sortBy('order');
  const firstUndone = subtasks.find((s) => !s.deletedAt && s.status !== 'done');
  if (firstUndone) {
    await startWorkingOn(firstUndone.id);
  } else {
    await startWorkingOnTask(pick.id);
  }
  revealTask(pick.id, pick.listId);
  maybeStartTimer(startTimer);
}
