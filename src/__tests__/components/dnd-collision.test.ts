import type { Active, ClientRect, DroppableContainer } from '@dnd-kit/core';
import { customCollisionDetection, LIST_DROP_ID_PREFIX } from '../../components/layout/dnd-collision';

// A sidebar row is BOTH a sortable item (id = list id, for reordering lists)
// and a `list-drop-*` droppable (for dropping tasks onto the list). Both have
// the same rect, so closestCenter could pick the drop target while a list was
// being reordered; the reorder then found no index for it and did nothing.

function rect(top: number, height = 32, left = 0, width = 240): ClientRect {
  return { top, left, width, height, bottom: top + height, right: left + width };
}

function container(id: string, data: Record<string, unknown>, r: ClientRect): DroppableContainer {
  return {
    id,
    key: id,
    data: { current: data },
    disabled: false,
    node: { current: null },
    rect: { current: r },
  };
}

function sidebarRows(names: string[]) {
  const containers: DroppableContainer[] = [];
  const rects = new Map<string, ClientRect>();
  names.forEach((name, i) => {
    const r = rect(100 + i * 32);
    const data = { type: 'sidebarList', listId: name, listType: 'tasks', listName: name };
    // The row's drop target registers before its sortable wrapper (child effects
    // run first), so it comes first here too, as in the real app.
    containers.push(container(`${LIST_DROP_ID_PREFIX}${name}`, data, r));
    containers.push(container(name, { ...data, sortable: { containerId: 'lists', index: i, items: names } }, r));
    rects.set(`${LIST_DROP_ID_PREFIX}${name}`, r);
    rects.set(name, r);
  });
  return { containers, rects };
}

function active(id: string, data: Record<string, unknown>): Active {
  return { id, data: { current: data }, rect: { current: { initial: null, translated: null } } };
}

describe('customCollisionDetection', () => {
  it('a sidebar list being reordered only collides with sortable rows, never list-drop targets', () => {
    const { containers, rects } = sidebarRows(['a', 'b', 'c']);
    const collisions = customCollisionDetection({
      active: active('a', { type: 'sidebarList', listId: 'a', listType: 'tasks' }),
      collisionRect: rect(164), // over row "c"
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 60, y: 180 },
    });
    expect(collisions[0]?.id).toBe('c');
    expect(collisions.some((c) => String(c.id).startsWith(LIST_DROP_ID_PREFIX))).toBe(false);
  });

  it('a task dragged over the sidebar still lands on that list', () => {
    const { containers, rects } = sidebarRows(['a', 'b', 'c']);
    const collisions = customCollisionDetection({
      active: active('task-1', { type: 'task', listId: 'other', title: 'T' }),
      collisionRect: rect(132),
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 60, y: 148 },
    });
    const over = collisions[0];
    expect(over).toBeDefined();
    const overData = containers.find((c) => c.id === over.id)?.data.current;
    expect(overData).toMatchObject({ type: 'sidebarList', listId: 'b' });
  });
});
