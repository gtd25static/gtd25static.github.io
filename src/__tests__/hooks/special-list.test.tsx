// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import '../setup-component';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, setTaskStatus } from '../../hooks/use-tasks';
import { createSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
import { toggleWarning } from '../../hooks/use-warning';
import { SpecialListProvider, useSpecialListContext } from '../../hooks/use-special-list';

function renderSpecialList() {
  const wrapper = ({ children }: { children: ReactNode }) => <SpecialListProvider>{children}</SpecialListProvider>;
  return renderHook(() => useSpecialListContext(), { wrapper });
}

let listId: string;

beforeEach(async () => {
  await resetDb();
  listId = (await createTaskList('Work')).id;
});

afterEach(() => vi.restoreAllMocks());

describe('useSpecialList (Attention / sidebar counters)', { timeout: 15_000 }, () => {
  // toggleWarning stores hasWarning: true. Booleans are not valid IndexedDB
  // keys, so the `hasWarning` index never holds a row and the old
  // where('hasWarning').equals(1) query always came back empty.
  it('counts a warned task', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Warn me' }));
    await toggleWarning('task', task.id);

    const { result } = renderSpecialList();
    await waitFor(() => expect(result.current.warningCount).toBe(1));
    expect(result.current.items).toEqual([
      expect.objectContaining({ id: task.id, type: 'warning', entityType: 'task', title: 'Warn me' }),
    ]);
  });

  it('counts a warned subtask and a warned follow-up', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(parent.id, { title: 'Sub' }));
    await toggleWarning('subtask', sub.id);
    const leads = await createTaskList('Leads', 'follow-ups');
    const topic = assertDefined(await createTask(leads.id, { title: 'Topic' }));
    await toggleWarning('task', topic.id);

    const { result } = renderSpecialList();
    await waitFor(() => expect(result.current.warningCount).toBe(2));
    expect(result.current.items.map((i) => i.id).sort()).toEqual([sub.id, topic.id].sort());
  });

  it('drops a warning once cleared, done or deleted', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Warn me' }));
    await toggleWarning('task', task.id);
    const { result } = renderSpecialList();
    await waitFor(() => expect(result.current.warningCount).toBe(1));

    await act(() => setTaskStatus(task.id, 'done'));
    await waitFor(() => expect(result.current.warningCount).toBe(0));
  });

  it('ignores warned and blocked subtasks of a done parent', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Parent' }));
    const warned = assertDefined(await createSubtask(parent.id, { title: 'Warned sub' }));
    const blocked = assertDefined(await createSubtask(parent.id, { title: 'Blocked sub' }));
    await toggleWarning('subtask', warned.id);
    await setSubtaskStatus(blocked.id, 'blocked');

    const { result } = renderSpecialList();
    await waitFor(() => {
      expect(result.current.warningCount).toBe(1);
      expect(result.current.blockedCount).toBe(1);
    });

    await act(() => setTaskStatus(parent.id, 'done'));
    await waitFor(() => {
      expect(result.current.warningCount).toBe(0);
      expect(result.current.blockedCount).toBe(0);
    });
  });

  it('picks up a recurring task falling due without any DB write', async () => {
    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base);
    await createTask(listId, {
      title: 'Water plants',
      recurrenceType: 'time-based',
      recurrenceInterval: 1,
      recurrenceUnit: 'days',
      nextOccurrence: base + 30_000,
    });

    const { result } = renderSpecialList();
    // Let the first query settle before moving the clock.
    await waitFor(() => expect(result.current).toBeDefined());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.recurringCount).toBe(0);

    vi.spyOn(Date, 'now').mockReturnValue(base + 120_000);
    // The minute tick also fires when the page becomes visible again.
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(result.current.recurringCount).toBe(1));
  });
});
