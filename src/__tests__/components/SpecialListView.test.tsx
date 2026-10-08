// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { toggleWarning } from '../../hooks/use-warning';
import { SpecialListProvider } from '../../hooks/use-special-list';
import { SpecialListView } from '../../components/tasks/SpecialListView';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { updateTask } from '../../hooks/use-tasks';
import { useAppState } from '../../stores/app-state';
import { resetAppState } from '../helpers/component-helpers';

function renderAttention() {
  const user = userEvent.setup();
  render(
    <SpecialListProvider>
      <ConfirmDialogContainer />
      <SpecialListView />
    </SpecialListProvider>,
  );
  return user;
}

beforeEach(async () => {
  await resetDb();
  resetAppState();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('SpecialListView (Attention)', { timeout: 15_000 }, () => {
  // "Done" set status 'done' on a follow-up, a state follow-ups don't have: it
  // stayed an active card, now without its warning, and nothing showed why.
  it('resolves a warned follow-up instead of marking it done, after asking', async () => {
    const leads = await createTaskList('Leads', 'follow-ups');
    const topic = assertDefined(await createTask(leads.id, { title: 'Call Ana' }));
    await toggleWarning('task', topic.id);

    const user = renderAttention();
    expect(await screen.findByText('Call Ana')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect((await db.tasks.get(topic.id))?.archived).toBeFalsy(); // asks first
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resolve' }));

    await waitFor(async () => expect((await db.tasks.get(topic.id))?.archived).toBe(true));
    const resolved = assertDefined(await db.tasks.get(topic.id));
    expect(resolved.status).toBe('todo');
    expect(resolved.completedAt).toBeUndefined();
  });

  it('cancelling the question leaves the follow-up as it was', async () => {
    const leads = await createTaskList('Leads', 'follow-ups');
    const topic = assertDefined(await createTask(leads.id, { title: 'Call Ana' }));
    await toggleWarning('task', topic.id);

    const user = renderAttention();
    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    const untouched = assertDefined(await db.tasks.get(topic.id));
    expect(untouched.archived).toBeFalsy();
    expect(untouched.status).toBe('todo');
  });

  it('still marks a warned task done, without asking', async () => {
    const work = await createTaskList('Work');
    const task = assertDefined(await createTask(work.id, { title: 'Ship it' }));
    await toggleWarning('task', task.id);

    const user = renderAttention();
    await user.click(await screen.findByRole('button', { name: 'Done' }));

    await waitFor(async () => expect((await db.tasks.get(task.id))?.status).toBe('done'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A click toggled the task open/closed, so on an open one it closed it; and a
  // snoozed follow-up landed in a list that hid it.
  it('takes you to a snoozed follow-up with it on screen and open, and a second click keeps it open', async () => {
    const leads = await createTaskList('Leads', 'follow-ups');
    const topic = assertDefined(await createTask(leads.id, { title: 'Call Ana' }));
    await toggleWarning('task', topic.id);
    await updateTask(topic.id, { pingedAt: Date.now(), pingCooldown: 'custom', pingCooldownUntil: Date.now() + 86_400_000 });

    const user = renderAttention();
    await user.click(await screen.findByText('Call Ana'));
    let s = useAppState.getState();
    expect(s.selectedListId).toBe(leads.id);
    expect(s.followUpViews[leads.id]?.showSnoozed).toBe(true);
    expect(s.expandedTaskIds.has(topic.id)).toBe(true);
    expect(s.focusedItemId).toBe(topic.id);

    await user.click(screen.getByText('Call Ana'));
    s = useAppState.getState();
    expect(s.expandedTaskIds.has(topic.id)).toBe(true);
  });
});
