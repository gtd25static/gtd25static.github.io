import { useEffect, useState, type ReactNode } from 'react';
import {
  DndContext,
  useDndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { customCollisionDetection } from './dnd-collision';
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

// Tailwind's transition-transform on the phone drawer lasts 150ms; re-measure
// a little after it has settled.
const DRAWER_SETTLE_MS = 300;

// dnd-kit measures droppables when a drag starts and doesn't re-measure when an
// ancestor moves. On phones the drawer auto-opens on drag start, still
// off-screen (-translate-x-full) at that moment, so its lists were measured
// off-screen and could never be hit. Re-measure once the drawer has slid in.
function RemeasureAfterDrawerOpens({ opens }: { opens: number }) {
  const { measureDroppableContainers } = useDndContext();
  useEffect(() => {
    if (!opens) return;
    const timer = setTimeout(() => measureDroppableContainers([]), DRAWER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [opens, measureDroppableContainers]);
  return null;
}

export function DndProvider({ children }: { children: ReactNode }) {
  const [activeDrag, setActiveDrag] = useState<{ id: string; data: DragItemData } | null>(null);
  const [drawerOpens, setDrawerOpens] = useState(0);
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
        setDrawerOpens((n) => n + 1);
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

    // Cross-list move: task/follow-up dropped on a sidebar list, of either type
    // (moveTaskToList translates the state that doesn't carry across).
    if (
      (activeData.type === 'task' || activeData.type === 'follow-up') &&
      overData.type === 'sidebarList'
    ) {
      // Don't move to the same list
      if (activeData.listId === overData.listId) return;
      if (activeData.hasSubtasks && overData.listType === 'follow-ups') {
        toast("A task with subtasks can't become a follow-up", 'info');
        return;
      }
      const listName = overData.listName ?? 'list';
      void moveTaskToList(String(active.id), overData.listId!).then((moved) => {
        if (moved) toast(`Moved to ${listName}`, 'success');
      });
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
      <RemeasureAfterDrawerOpens opens={drawerOpens} />
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div className="rounded-lg border border-accent-500/50 bg-white px-3 py-2 shadow-xl dark:bg-zinc-800 dark:border-accent-400/50 max-w-xs">
            <span data-redact className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-1">
              {activeDrag.data.title ?? activeDrag.id}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
