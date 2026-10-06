import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask } from '../../hooks/use-tasks';
import { createSubtask, updateSubtask } from '../../hooks/use-subtasks';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: vi.fn() }));
import { toast } from '../../components/ui/Toast';
import { confirmDialog } from '../../components/ui/ConfirmDialog';
import { makeSubtaskOf, promoteToTask } from '../../components/subtasks/convert-actions';

// Reliability review 2026-10-06 (M5): turning a subtask into a task dropped its
// links and warning; dropping a task onto another made it a subtask without its
// description, discussion history or recurrence — silently, with no Undo.

let listId: string;

beforeEach(async () => {
  await resetDb();
  listId = (await createTaskList('Work')).id;
  vi.mocked(toast).mockClear();
  vi.mocked(confirmDialog).mockReset();
});

function undoOfLastToast(): () => void {
  const call = vi.mocked(toast).mock.calls.at(-1);
  return assertDefined(call?.[2], 'undo');
}

describe('promote a subtask to a task', () => {
  it('keeps its links, warning, blocked and completion state, and can be undone', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Trip' }));
    const sub = assertDefined(await createSubtask(parent.id, { title: 'Book hotel', links: [{ url: 'https://h.example', title: 'h' }] }));
    await updateSubtask(sub.id, { hasWarning: 1, warningAt: 123, blockedAt: 456, status: 'blocked' });

    const taskId = assertDefined(await promoteToTask(sub.id, listId));

    const task = assertDefined(await db.tasks.get(taskId));
    expect(task).toMatchObject({ title: 'Book hotel', links: [{ url: 'https://h.example', title: 'h' }], hasWarning: 1, warningAt: 123, blockedAt: 456, status: 'blocked' });

    undoOfLastToast()();
    await vi.waitFor(async () => expect((await db.tasks.get(taskId))?.deletedAt).toBeDefined());
    expect((await db.subtasks.get(sub.id))?.deletedAt).toBeUndefined();
  });
});

describe('make a task a subtask of another', () => {
  it('asks first when the task has what a subtask cannot hold, and does nothing if declined', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Trip' }));
    const task = assertDefined(await createTask(listId, { title: 'Visa', description: 'Embassy needs two photos' }));
    vi.mocked(confirmDialog).mockResolvedValue(false);

    expect(await makeSubtaskOf(task.id, parent.id)).toBeUndefined();

    expect(vi.mocked(confirmDialog).mock.calls[0][0]).toMatch(/description/);
    expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined();
    expect(await db.subtasks.where('taskId').equals(parent.id).count()).toBe(0);
  });

  it('names the discussion history and the recurrence too', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Trip' }));
    const task = assertDefined(await createTask(listId, { title: 'Water plants', recurrenceType: 'date-based', recurrenceInterval: 1, recurrenceUnit: 'weeks' }));
    await updateTask(task.id, { discussionLog: [{ id: 'd1', at: 1, note: 'talked' }] as never });
    vi.mocked(confirmDialog).mockResolvedValue(false);

    await makeSubtaskOf(task.id, parent.id);

    const message = vi.mocked(confirmDialog).mock.calls[0][0];
    expect(message).toMatch(/discussion history/);
    expect(message).toMatch(/recurrence/);
  });

  it('a plain task converts without asking, and Undo brings the task back whole', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Trip' }));
    const task = assertDefined(await createTask(listId, { title: 'Pack', links: [{ url: 'https://l.example' }] }));
    await updateTask(task.id, { starred: true });

    const subId = assertDefined(await makeSubtaskOf(task.id, parent.id));

    expect(confirmDialog).not.toHaveBeenCalled();
    expect((await db.subtasks.get(subId))?.links).toEqual([{ url: 'https://l.example' }]);
    undoOfLastToast()();
    await vi.waitFor(async () => expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined());
    expect((await db.tasks.get(task.id))?.starred).toBe(true);
    expect((await db.subtasks.get(subId))?.deletedAt).toBeDefined();
  });

  it('confirmed, it converts and offers Undo', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Trip' }));
    const task = assertDefined(await createTask(listId, { title: 'Visa', description: 'Embassy needs two photos' }));
    vi.mocked(confirmDialog).mockResolvedValue(true);

    const subId = assertDefined(await makeSubtaskOf(task.id, parent.id));

    expect((await db.subtasks.get(subId))?.taskId).toBe(parent.id);
    undoOfLastToast()();
    await vi.waitFor(async () => expect((await db.tasks.get(task.id))?.description).toBe('Embassy needs two photos'));
    expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined();
  });
});
