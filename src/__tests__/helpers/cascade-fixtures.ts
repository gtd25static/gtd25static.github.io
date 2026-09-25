import { db } from '../../db';
import { assertDefined } from './db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask } from '../../hooks/use-subtasks';

/** Let the millisecond clock move on so the next delete gets its own deletedAt. */
export const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A list with one live task (`keep`, one live subtask and one deleted earlier)
 * and one task deleted earlier together with its subtask. `earlier` holds the
 * deletedAt values the individual deletes stamped, so a later cascade can be
 * checked against them.
 */
export async function seedListWithEarlierDeletes() {
  const list = await createTaskList('Proj');
  const keep = assertDefined(await createTask(list.id, { title: 'Keep' }));
  const keepSub = assertDefined(await createSubtask(keep.id, { title: 'Keep sub' }));
  const goneSub = assertDefined(await createSubtask(keep.id, { title: 'Sub deleted earlier' }));
  const gone = assertDefined(await createTask(list.id, { title: 'Deleted earlier' }));
  const goneChild = assertDefined(await createSubtask(gone.id, { title: 'Child of deleted task' }));
  await deleteSubtask(goneSub.id);
  await deleteTask(gone.id);
  const earlier = {
    goneSub: assertDefined((await db.subtasks.get(goneSub.id))?.deletedAt),
    gone: assertDefined((await db.tasks.get(gone.id))?.deletedAt),
    goneChild: assertDefined((await db.subtasks.get(goneChild.id))?.deletedAt),
  };
  await tick();
  return { list, keep, keepSub, goneSub, gone, goneChild, earlier };
}

/** Ids of the change-log entries with the given operation. */
export async function loggedIds(operation: 'upsert' | 'delete'): Promise<string[]> {
  return (await db.changeLog.toArray())
    .filter((e) => e.operation === operation)
    .map((e) => e.entityId)
    .sort();
}
