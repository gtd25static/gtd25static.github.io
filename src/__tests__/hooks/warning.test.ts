import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { toggleWarning } from '../../hooks/use-warning';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Test List');
  listId = list.id;
});

describe('toggleWarning', () => {
  describe('task warning', () => {
    it('sets hasWarning and warningAt on a task', async () => {
      const task = assertDefined(await createTask(listId, { title: 'Warn me' }));
      expect(task.hasWarning).toBeFalsy();

      await toggleWarning('task', task.id);
      const updated = assertDefined(await db.tasks.get(task.id));
      expect(updated.hasWarning).toBe(true);
      expect(updated.warningAt).toBeGreaterThan(0);
    });

    it('clears hasWarning and warningAt on second toggle', async () => {
      const task = assertDefined(await createTask(listId, { title: 'Warn me' }));
      await toggleWarning('task', task.id);
      await toggleWarning('task', task.id);

      const updated = assertDefined(await db.tasks.get(task.id));
      expect(updated.hasWarning).toBeUndefined();
      expect(updated.warningAt).toBeUndefined();
    });

    it('no-ops for non-existent task', async () => {
      // Should not throw
      await toggleWarning('task', 'nonexistent');
    });
  });

  describe('subtask warning', () => {
    it('sets hasWarning and warningAt on a subtask', async () => {
      const task = assertDefined(await createTask(listId, { title: 'Parent' }));
      const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

      await toggleWarning('subtask', sub.id);
      const updated = assertDefined(await db.subtasks.get(sub.id));
      expect(updated.hasWarning).toBe(true);
      expect(updated.warningAt).toBeGreaterThan(0);
    });

    it('clears hasWarning and warningAt on second toggle', async () => {
      const task = assertDefined(await createTask(listId, { title: 'Parent' }));
      const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

      await toggleWarning('subtask', sub.id);
      await toggleWarning('subtask', sub.id);

      const updated = assertDefined(await db.subtasks.get(sub.id));
      expect(updated.hasWarning).toBeUndefined();
      expect(updated.warningAt).toBeUndefined();
    });

    it('no-ops for non-existent subtask', async () => {
      await toggleWarning('subtask', 'nonexistent');
    });
  });
});
