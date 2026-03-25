import { useState, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { moveTaskToList } from '../../hooks/use-tasks';
import { convertTaskToSubtask } from '../../hooks/use-subtasks';
import { toast } from '../ui/Toast';
import { useAppState } from '../../stores/app-state';

export interface DragItemData {
  type: 'task' | 'follow-up' | 'sidebarList' | 'subtask';
  listId?: string;
  listType?: 'tasks' | 'follow-ups';
  listName?: string;
  taskId?: string;
  title?: string;
  hasSubtasks?: boolean;
}

export interface DropZoneData {
  type: 'subtaskDropZone';
  taskId: string;
}

// Prioritize subtask drop zones over sortable items when dragging a task.
// Without this, closestCenter always picks sortable task items (compact centers)
// over the subtask drop zone (tall expanded area, center farther away).
const customCollisionDetection: CollisionDetection = (args) => {
  if (args.active.data.current?.type === 'task') {
    const subtaskZones = args.droppableContainers.filter(
      (c) => c.data.current?.type === 'subtaskDropZone'
    );
    if (subtaskZones.length > 0) {
      const collisions = pointerWithin({ ...args, droppableContainers: subtaskZones });
      if (collisions.length > 0) return collisions;
    }
  }
  return closestCenter(args);
};

export function DndProvider({ children }: { children: ReactNode }) {
  const [activeDrag, setActiveDrag] = useState<{ id: string; data: DragItemData } | null>(null);
  const sidebarOpen = useAppState((s) => s.sidebarOpen);
  const setSidebarOpen = useAppState((s) => s.setSidebarOpen);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragItemData | undefined;
    if (data) {
      setActiveDrag({ id: String(event.active.id), data });
      // Auto-open sidebar on mobile for cross-list drag
      if ((data.type === 'task' || data.type === 'follow-up') && !sidebarOpen && window.innerWidth < 768) {
        setSidebarOpen(true);
      }
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeData = active.data.current as DragItemData | undefined;
    const overData = over.data.current as (DragItemData | DropZoneData) | undefined;
    if (!activeData || !overData) return;

    // Cross-list move: task/follow-up dropped on a sidebar list
    if (
      (activeData.type === 'task' || activeData.type === 'follow-up') &&
      overData.type === 'sidebarList'
    ) {
      // Validate type match: tasks to task lists, follow-ups to follow-up lists
      if (activeData.listType !== overData.listType) return;
      // Don't move to the same list
      if (activeData.listId === overData.listId) return;
      moveTaskToList(String(active.id), overData.listId!);
      toast(`Moved to ${overData.listName ?? 'list'}`, 'success');
      return;
    }

    // Subtask conversion: task dropped on expanded task's subtask zone
    if (activeData.type === 'task' && overData.type === 'subtaskDropZone') {
      if (activeData.hasSubtasks) {
        toast('Cannot nest a task that has subtasks', 'info');
        return;
      }
      if (String(active.id) === overData.taskId) return;
      convertTaskToSubtask(String(active.id), overData.taskId);
      toast('Converted to subtask', 'success');
      return;
    }

    // All other cases (intra-list reorder, sidebar list reorder, subtask reorder)
    // are handled by useDndMonitor in individual components
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div className="rounded-lg border border-accent-500/50 bg-white px-3 py-2 shadow-xl dark:bg-zinc-800 dark:border-accent-400/50 max-w-xs">
            <span className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-1">
              {activeDrag.data.title ?? activeDrag.id}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
