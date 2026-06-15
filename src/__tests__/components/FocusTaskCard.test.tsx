// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../__tests__/setup-component';
import { FocusTaskCard } from '../../components/focus/FocusTaskCard';
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { resetAppState } from '../helpers/component-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { useAppState } from '../../stores/app-state';
import { usePomodoroStore } from '../../stores/pomodoro-store';
import type { Task } from '../../db/models';

const scrollIntoView = vi.fn();

let listId: string;
let task: Task;

beforeEach(async () => {
  await resetDb();
  resetAppState();
  usePomodoroStore.getState().stopTimer();
  scrollIntoView.mockClear();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const list = await createTaskList('List');
  listId = list.id;
  task = assertDefined(await createTask(listId, { title: 'Write the report' }));
});

// Render the card alongside a stand-in for the task's row in the destination list
// so revealTask's centre-scroll has an element to find (and returns immediately,
// instead of spinning its retry loop).
function renderCard() {
  return render(
    <>
      <FocusTaskCard task={task} />
      <div data-focus-id={task.id} />
    </>,
  );
}

describe('FocusTaskCard navigation', () => {
  it('clicking the card body reveals the task — no working, no timer', async () => {
    renderCard();

    fireEvent.click(screen.getByText('Write the report'));

    const app = useAppState.getState();
    expect(app.selectedListId).toBe(listId);
    expect(app.navigateToTaskId).toBe(task.id);
    expect(app.focusedItemId).toBe(task.id);
    expect(app.focusZone).toBe('main');
    expect(app.expandedTaskIds.has(task.id)).toBe(true);

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }),
    );

    // Pure navigation: workedAt untouched, no Pomodoro started.
    expect((await db.tasks.get(task.id))?.workedAt).toBeUndefined();
    expect(usePomodoroStore.getState().timerRunning).toBe(false);
  });

  it('clicking "Start 25 min" reveals the task, stamps workedAt, and starts the timer', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Start 25 min' }));

    await waitFor(() => expect(useAppState.getState().navigateToTaskId).toBe(task.id));
    const app = useAppState.getState();
    expect(app.selectedListId).toBe(listId);
    expect(app.focusedItemId).toBe(task.id);
    expect(app.focusZone).toBe('main');

    expect((await db.tasks.get(task.id))?.workedAt).toBeDefined();
    expect(usePomodoroStore.getState().timerRunning).toBe(true);
  });

  it('clicking "Complete" finishes the task in place and does not navigate', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));

    await waitFor(async () => expect((await db.tasks.get(task.id))?.status).toBe('done'));

    const app = useAppState.getState();
    expect(app.selectedListId).toBeNull();
    expect(app.navigateToTaskId).toBeNull();
    expect(app.focusedItemId).toBeNull();
    expect(usePomodoroStore.getState().timerRunning).toBe(false);
  });
});
