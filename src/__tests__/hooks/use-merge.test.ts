import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { mergeTasks, unmergeTasks, combineTaskContent } from '../../hooks/use-merge';
import type { Task } from '../../db/models';

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'x',
    listId: 'l',
    title: 'T',
    status: 'todo',
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('combineTaskContent', () => {
  it('concatenates distinct descriptions and skips duplicates', () => {
    const survivor = makeTask({ id: 's', description: 'Alpha' });
    const updates = combineTaskContent(survivor, [
      makeTask({ id: 'a', description: 'Beta' }),
      makeTask({ id: 'b', description: 'Alpha' }), // duplicate -> skipped
    ]);
    expect(updates.description).toContain('Alpha');
    expect(updates.description).toContain('Beta');
    expect(updates.description!.match(/Alpha/g)).toHaveLength(1);
  });

  it('unions links by URL, excluding the survivor primary link', () => {
    const survivor = makeTask({ id: 's', link: 'https://a', links: [{ url: 'https://b' }] });
    const updates = combineTaskContent(survivor, [
      makeTask({ id: 'a', link: 'https://b' }), // dup of existing link -> skipped
      makeTask({ id: 'b', links: [{ url: 'https://c', title: 'C' }] }),
    ]);
    expect(updates.links).toEqual([{ url: 'https://b' }, { url: 'https://c', title: 'C' }]);
  });

  it('unions discussionLog by id, ordered oldest-first', () => {
    const survivor = makeTask({ id: 's', discussionLog: [{ id: 'd1', at: 100 }] });
    const updates = combineTaskContent(survivor, [
      makeTask({ id: 'a', discussionLog: [{ id: 'd2', at: 50 }] }),
    ]);
    expect(updates.discussionLog!.map((e) => e.id)).toEqual(['d2', 'd1']);
  });

  it('takes the earliest source due date only when the survivor has none, and ORs flags', () => {
    const survivor = makeTask({ id: 's' });
    const updates = combineTaskContent(survivor, [
      makeTask({ id: 'a', dueDate: 200, starred: true }),
      makeTask({ id: 'b', dueDate: 150 }),
    ]);
    expect(updates.dueDate).toBe(150);
    expect(updates.starred).toBe(true);
  });

  it('keeps the survivor due date when present', () => {
    const survivor = makeTask({ id: 's', dueDate: 999 });
    const updates = combineTaskContent(survivor, [makeTask({ id: 'a', dueDate: 1 })]);
    expect(updates.dueDate).toBeUndefined();
  });
});

describe('mergeTasks / unmergeTasks (DB)', () => {
  let listId: string;
  beforeEach(async () => {
    await resetDb();
    listId = (await createTaskList('Test List')).id;
  });

  it('folds content into the survivor, re-parents subtasks, and soft-deletes sources', async () => {
    const survivor = assertDefined(await createTask(listId, { title: 'Comprar leche', description: 'con nata' }));
    const src1 = assertDefined(await createTask(listId, { title: 'comprar Leche', description: 'desnatada', link: 'https://shop.example/milk' }));
    const sub = assertDefined(await createSubtask(src1.id, { title: 'marca X' }));
    const src2 = assertDefined(await createTask(listId, { title: 'COMPRAR leche' }));

    const snapshot = await mergeTasks(survivor.id, [src1.id, src2.id]);
    expect(snapshot).toBeDefined();
    expect(snapshot!.sources).toHaveLength(2);
    expect(snapshot!.reparented).toHaveLength(1);

    const merged = assertDefined(await db.tasks.get(survivor.id));
    expect(merged.title).toBe('Comprar leche'); // survivor's title wins
    expect(merged.description).toContain('con nata');
    expect(merged.description).toContain('desnatada');
    expect(merged.links?.some((l) => l.url === 'https://shop.example/milk')).toBe(true);

    expect((await db.subtasks.get(sub.id))?.taskId).toBe(survivor.id);
    expect((await db.tasks.get(src1.id))?.deletedAt).toBeDefined();
    expect((await db.tasks.get(src2.id))?.deletedAt).toBeDefined();

    const changes = await db.changeLog.toArray();
    expect(changes.some((c) => c.entityType === 'task' && c.entityId === survivor.id && c.operation === 'upsert')).toBe(true);
    expect(changes.some((c) => c.entityType === 'task' && c.entityId === src1.id && c.operation === 'delete')).toBe(true);
  });

  it('unions discussionLog entries from every merged follow-up', async () => {
    const a = assertDefined(await createTask(listId, { title: 'Topic' }));
    const b = assertDefined(await createTask(listId, { title: 'topic' }));
    await updateTask(a.id, { discussionLog: [{ id: 'd1', at: 100, note: 'late' }] });
    await updateTask(b.id, { discussionLog: [{ id: 'd2', at: 50, note: 'early' }] });

    await mergeTasks(a.id, [b.id]);
    const merged = assertDefined(await db.tasks.get(a.id));
    expect(merged.discussionLog?.map((e) => e.id)).toEqual(['d2', 'd1']);
  });

  it('never merges entries from another list', async () => {
    const otherListId = (await createTaskList('Other')).id;
    const survivor = assertDefined(await createTask(listId, { title: 'Here' }));
    const foreign = assertDefined(await createTask(otherListId, { title: 'Here' }));

    const snapshot = await mergeTasks(survivor.id, [foreign.id]);
    expect(snapshot).toBeUndefined();
    expect((await db.tasks.get(foreign.id))?.deletedAt).toBeUndefined();
  });

  it('Undo restores the survivor, sources, and subtask parentage exactly', async () => {
    const survivor = assertDefined(await createTask(listId, { title: 'Keep', description: 'original' }));
    const src = assertDefined(await createTask(listId, { title: 'keep', description: 'extra' }));
    const sub = assertDefined(await createSubtask(src.id, { title: 'child' }));

    const snapshot = assertDefined(await mergeTasks(survivor.id, [src.id]));
    // Sanity: merge happened.
    expect((await db.tasks.get(src.id))?.deletedAt).toBeDefined();
    expect((await db.subtasks.get(sub.id))?.taskId).toBe(survivor.id);

    await unmergeTasks(snapshot);
    const restored = assertDefined(await db.tasks.get(survivor.id));
    expect(restored.description).toBe('original'); // merged content reverted
    expect(restored.links).toBeUndefined();
    expect((await db.tasks.get(src.id))?.deletedAt).toBeUndefined(); // un-deleted
    expect((await db.subtasks.get(sub.id))?.taskId).toBe(src.id); // re-parented back
  });
});
