import { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useFollowUps } from '../../hooks/use-follow-ups';
import { createTask, reorderTasks } from '../../hooks/use-tasks';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import type { Task } from '../../db/models';
import { FollowUpCard } from './FollowUpCard';
import { InlineTaskForm } from '../tasks/InlineTaskForm';
import { DropdownMenu } from '../ui/DropdownMenu';

function SortableFollowUpItem({ task, index }: { task: Task; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <FollowUpCard task={task} index={index} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

interface Props {
  listId: string;
  listName: string;
}

export function FollowUpList({ listId, listName }: Props) {
  const { active, archived } = useFollowUps(listId);
  const { navigateToTaskId, setNavigateToTaskId, creatingTask, setCreatingTask, focusedItemId, focusZone } = useAppState(useShallow(s => ({ navigateToTaskId: s.navigateToTaskId, setNavigateToTaskId: s.setNavigateToTaskId, creatingTask: s.creatingTask, setCreatingTask: s.setCreatingTask, focusedItemId: s.focusedItemId, focusZone: s.focusZone })));
  const [creating, setCreating] = useState(false);

  // React to keyboard-triggered task creation (n key) and cancellation (Esc)
  useEffect(() => {
    if (creatingTask && !creating) {
      setCreating(true);
    } else if (!creatingTask && creating) {
      setCreating(false);
    }
  }, [creatingTask]);
  const [showArchived, setShowArchived] = useState(false);

  // Auto-open Archived section when navigating to an archived follow-up from search
  useEffect(() => {
    if (!navigateToTaskId) return;
    const inArchived = archived.some((t) => t.id === navigateToTaskId);
    if (inArchived) {
      setShowArchived(true);
    }
    setNavigateToTaskId(null);
  }, [navigateToTaskId, archived]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active: dragActive, over } = event;
    if (!over || dragActive.id === over.id) return;

    const oldIndex = active.findIndex((t) => t.id === dragActive.id);
    const newIndex = active.findIndex((t) => t.id === over.id);
    const newOrder = [...active];
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);
    reorderTasks(newOrder.map((t) => t.id));
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          {/* Header */}
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">{listName}</h2>
            <DropdownMenu
              trigger={
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
                  <circle cx="10" cy="4" r="1.5" />
                  <circle cx="10" cy="10" r="1.5" />
                  <circle cx="10" cy="16" r="1.5" />
                </svg>
              }
              items={[
                { label: 'Sort by date', onClick: () => {} },
              ]}
            />
          </div>

          {/* Add inline */}
          {creating ? (
            <InlineTaskForm
              onSubmit={(data) => { createTask(listId, data); setCreatingTask(false); }}
              onCancel={() => { setCreating(false); setCreatingTask(false); }}
            />
          ) : (
            <button
              data-focus-id="create-task"
              onClick={() => setCreating(true)}
              className={`flex w-full items-center gap-3 rounded-lg py-3 text-sm text-accent-600 hover:text-accent-700 dark:text-accent-400 ${focusedItemId === 'create-task' && focusZone === 'main' ? 'ring-2 ring-accent-500/40 dark:ring-accent-400/30' : ''}`}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-600 dark:text-accent-400">
                <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                <path d="M10 6v8M6 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Add a follow-up
            </button>
          )}

          {active.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
              <p className="text-sm">No follow-ups yet</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={active.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div>
                  {active.map((task, i) => (
                    <SortableFollowUpItem key={task.id} task={task} index={i} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {archived.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="flex items-center gap-2 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`transition-transform ${showArchived ? 'rotate-90' : ''}`}
                >
                  <path d="M6 3l5 5-5 5z" />
                </svg>
                Archived ({archived.length})
              </button>
              {showArchived && (
                <div>
                  {archived.map((task, i) => (
                    <div key={task.id} className="opacity-50">
                      <FollowUpCard task={task} index={i} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
