import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';

/** Id prefix of a sidebar row's drop target for tasks (`${prefix}${listId}`). */
export const LIST_DROP_ID_PREFIX = 'list-drop-';

export const customCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type;

  // Prioritize subtask drop zones over sortable items when dragging a task.
  // Without this, closestCenter always picks sortable task items (compact centers)
  // over the subtask drop zone (tall expanded area, center farther away).
  if (activeType === 'task') {
    const subtaskZones = args.droppableContainers.filter(
      (c) => c.data.current?.type === 'subtaskDropZone'
    );
    if (subtaskZones.length > 0) {
      const collisions = pointerWithin({ ...args, droppableContainers: subtaskZones });
      if (collisions.length > 0) return collisions;
    }
  }

  // A sidebar row is both a sortable item (id = list id) and a drop target for
  // tasks (`list-drop-*`) with the same rect. A list being reordered must only
  // collide with the sortable rows: when closestCenter picked the drop target
  // instead, the reorder found no index for it and nothing moved.
  if (activeType === 'sidebarList') {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => !String(c.id).startsWith(LIST_DROP_ID_PREFIX)
      ),
    });
  }

  return closestCenter(args);
};
