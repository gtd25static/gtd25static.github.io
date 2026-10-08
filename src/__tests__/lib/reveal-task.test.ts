// @vitest-environment jsdom
import { resetAppState } from '../helpers/component-helpers';
import { useAppState } from '../../stores/app-state';
import { revealTask } from '../../lib/reveal-task';

const scrollIntoView = vi.fn();

beforeEach(() => {
  resetAppState();
  vi.useFakeTimers();
  scrollIntoView.mockClear();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

function addTarget(id: string) {
  const el = document.createElement('div');
  el.dataset.focusId = id;
  document.body.appendChild(el);
}

describe('revealTask', () => {
  it('opens the list, opens the task (never closes it), focuses and centres it', () => {
    useAppState.getState().ensureTaskExpanded('t1'); // already open
    addTarget('t1');
    revealTask({ taskId: 't1', listId: 'L1', listType: 'tasks' });
    vi.runOnlyPendingTimers();

    const s = useAppState.getState();
    expect(s.selectedListId).toBe('L1');
    expect(s.expandedTaskIds.has('t1')).toBe(true);
    expect(s.navigateToTaskId).toBe('t1'); // TaskListView opens Completed for a done task
    expect(s.focusZone).toBe('main');
    expect(s.focusedItemId).toBe('t1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('uncovers a snoozed follow-up and leaves the rest of the list view as it was', () => {
    useAppState.getState().setFollowUpView('F1', { sort: 'discussed' });
    revealTask({ taskId: 'f1', listId: 'F1', listType: 'follow-ups', snoozed: true });
    const s = useAppState.getState();
    expect(s.followUpViews.F1).toEqual({ showSnoozed: true, showResolved: false, sort: 'discussed' });
    expect(s.expandedTaskIds.has('f1')).toBe(true);
    expect(s.navigateToTaskId).toBeNull();
  });

  it('opens the Resolved section for a resolved follow-up', () => {
    revealTask({ taskId: 'f1', listId: 'F1', listType: 'follow-ups', resolved: true });
    expect(useAppState.getState().followUpViews.F1).toMatchObject({ showResolved: true, showSnoozed: false });
  });

  it('waits for the target to render, then rings and centres it (a subtask; else its task)', () => {
    revealTask({ taskId: 't1', listId: 'L1', listType: 'tasks', focusId: 's1' });
    vi.advanceTimersByTime(100);
    expect(scrollIntoView).not.toHaveBeenCalled();
    addTarget('t1');
    vi.advanceTimersByTime(60);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(useAppState.getState().focusedItemId).toBe('t1');
  });
});
