import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';

/** Id prefix of a sidebar row's drop target for tasks (`${prefix}${listId}`). */
export const LIST_DROP_ID_PREFIX = 'list-drop-';

export const customCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type;

  // A task/follow-up dropped with the pointer on a sidebar list goes to that
  // list. closestCenter measures from the centre of the dragged card: on a
  // phone the drawer covers the task list and the card is screen-wide, so that
  // centre stayed nearer the card's own slot (behind the drawer) than the list
  // under the finger, and the drop did nothing. Checked first because the
  // drawer sits on top of any subtask zone behind it.
  if (activeType === 'task' || activeType === 'follow-up') {
    const listTargets = args.droppableContainers.filter(
      (c) => String(c.id).startsWith(LIST_DROP_ID_PREFIX)
    );
    const collisions = pointerWithin({ ...args, droppableContainers: listTargets });
    if (collisions.length > 0) return collisions;
  }

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
