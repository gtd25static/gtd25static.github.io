import type { ListType } from '../db/models';
import { useAppState } from '../stores/app-state';

export interface RevealTarget {
  taskId: string;
  listId: string;
  listType: ListType;
  /** Where the keyboard ring lands (a subtask's id); the task's own by default. */
  focusId?: string;
  /** A follow-up in the Resolved section. */
  resolved?: boolean;
  /** A follow-up in its snooze, hidden unless "Show snoozed" is on. */
  snoozed?: boolean;
}

function findFocusElement(id: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>('[data-focus-id]');
  return Array.from(nodes).find((node) => node.dataset.focusId === id) ?? null;
}

/**
 * Centre `[data-focus-id=targetId]` (else the fallback's) once it's rendered —
 * the view it lives in may only be mounting — and put the keyboard ring on it.
 * Gives up after ~1.5 s.
 */
export function scrollToFocusTarget(targetId: string, fallbackId?: string): void {
  let attempts = 0;
  const tryScroll = () => {
    const el = findFocusElement(targetId) ?? (fallbackId ? findFocusElement(fallbackId) : null);
    if (el) {
      useAppState.getState().setFocusedItem(el.dataset.focusId ?? targetId);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (++attempts < 30) window.setTimeout(tryScroll, 50);
  };
  window.setTimeout(tryScroll, 0);
}

/**
 * Take the user to a task or follow-up from elsewhere (search, Focus, Attention,
 * Due soon): open its list, uncover the section it's in, open it (subtasks, or
 * the discussion log), and focus and centre it once it's on screen. It opens,
 * never toggles: a click on a task that was already open used to close it.
 */
export function revealTask(target: RevealTarget): void {
  const app = useAppState.getState();
  const { taskId, listId } = target;
  const focusId = target.focusId ?? taskId;
  if (target.listType === 'follow-ups') {
    // Set here rather than signalled: the list may not have loaded its rows yet.
    if (target.resolved) app.setFollowUpView(listId, { showResolved: true });
    else if (target.snoozed) app.setFollowUpView(listId, { showSnoozed: true });
  } else {
    // TaskListView opens its Completed section for a done task.
    app.setNavigateToTaskId(taskId);
  }
  app.selectList(listId);
  app.ensureTaskExpanded(taskId);
  app.setFocusZone('main');
  app.setFocusedItem(focusId);
  scrollToFocusTarget(focusId, taskId);
}
