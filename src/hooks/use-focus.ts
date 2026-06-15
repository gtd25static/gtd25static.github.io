import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { updateTask } from './use-tasks';

// Poll for the task's row in the freshly-mounted list view and scroll it to the
// vertical centre. We retry because navigating away from Focus Mode unmounts
// FocusView and mounts TaskListView, so the element isn't in the DOM at click
// time. Mirrors SearchResults.scrollToResult.
function scrollFocusIntoView(taskId: string): void {
  let attempts = 0;
  const tryScroll = () => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-focus-id]');
    const el = Array.from(nodes).find((node) => node.dataset.focusId === taskId);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (++attempts < 30) window.setTimeout(tryScroll, 50);
  };
  window.setTimeout(tryScroll, 0);
}

export function revealTask(taskId: string, listId: string): void {
  const app = useAppState.getState();
  app.selectList(listId);
  app.ensureTaskExpanded(taskId);
  app.setNavigateToTaskId(taskId);
  // Highlight ring (TaskCard gates on focusedItemId === id && focusZone === 'main')
  // plus centre-scroll once the row mounts in the target list.
  app.setFocusZone('main');
  app.setFocusedItem(taskId);
  scrollFocusIntoView(taskId);
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
