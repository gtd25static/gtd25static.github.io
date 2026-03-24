import { useState, useEffect, useRef } from 'react';
import {
  useDndMonitor,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTasks, createTask, reorderTasks } from '../../hooks/use-tasks';
import { useSubtasks } from '../../hooks/use-subtasks';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useTaskLists } from '../../hooks/use-task-lists';
import type { Task } from '../../db/models';
import type { DragItemData } from '../layout/DndProvider';
import { TaskCard } from './TaskCard';
import { InlineTaskForm } from './InlineTaskForm';
import { DropdownMenu } from '../ui/DropdownMenu';
import { FollowUpList } from '../follow-ups/FollowUpList';
import { BulkActionBar } from './BulkActionBar';
import { InboxListView } from './InboxListView';
import { isInboxList } from '../../lib/constants';
import { sortTasksForDisplay } from '../../lib/task-sort';

function SortableTaskItem({ task, index, listId }: { task: Task; index: number; listId: string }) {
  const subtasks = useSubtasks(task.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      listId,
      listType: 'tasks',
      title: task.title,
      hasSubtasks: subtasks.length > 0,
    } satisfies DragItemData,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TaskCard task={task} index={index} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

export function TaskListView() {
  const { selectedListId, navigateToTaskId, setNavigateToTaskId, creatingTask, setCreatingTask, focusedItemId, focusZone, bulkMode, setBulkMode } = useAppState(useShallow(s => ({ selectedListId: s.selectedListId, navigateToTaskId: s.navigateToTaskId, setNavigateToTaskId: s.setNavigateToTaskId, creatingTask: s.creatingTask, setCreatingTask: s.setCreatingTask, focusedItemId: s.focusedItemId, focusZone: s.focusZone, bulkMode: s.bulkMode, setBulkMode: s.setBulkMode })));
  const lists = useTaskLists();
  const tasks = useTasks(selectedListId);
  const [creating, setCreating] = useState(false);

  // React to keyboard-triggered task creation (n key) and cancellation (Esc)
  useEffect(() => {
    if (creatingTask && !creating) {
      setCreating(true);
    } else if (!creatingTask && creating) {
      setCreating(false);
    }
  }, [creatingTask]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [recentlyDone, setRecentlyDone] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const selectedList = lists.find((l) => l.id === selectedListId);

  // Auto-open Completed section when navigating to a done task from search
  useEffect(() => {
    if (!navigateToTaskId || !tasks.length) return;
    const target = tasks.find((t) => t.id === navigateToTaskId);
    if (target && target.status === 'done') {
      setShowCompleted(true);
    }
    setNavigateToTaskId(null);
  }, [navigateToTaskId, tasks]);

  // Keep recently-done tasks visible in the active list for 60s
  useEffect(() => {
    const now = Date.now();
    for (const task of tasks) {
      if (task.status === 'done' && !recentlyDone.has(task.id) && !timersRef.current.has(task.id)) {
        const elapsed = now - task.updatedAt;
        if (elapsed < 60_000) {
          setRecentlyDone((prev) => new Set(prev).add(task.id));
          const timer = setTimeout(() => {
            setRecentlyDone((prev) => {
              const next = new Set(prev);
              next.delete(task.id);
              return next;
            });
            timersRef.current.delete(task.id);
          }, 60_000 - elapsed);
          timersRef.current.set(task.id, timer);
        }
      }
    }
    // Clean up timers for tasks that were un-done
    for (const id of timersRef.current.keys()) {
      if (!tasks.some((t) => t.id === id && t.status === 'done')) {
        clearTimeout(timersRef.current.get(id));
        timersRef.current.delete(id);
        setRecentlyDone((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [tasks]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  const activeTasks = selectedList
    ? sortTasksForDisplay(tasks.filter((t) => t.status !== 'done' || recentlyDone.has(t.id)))
    : [];
  const completedTasks = selectedList
    ? tasks.filter((t) => t.status === 'done' && !recentlyDone.has(t.id))
    : [];

  // Handle intra-list task reorder via shared DndContext
  useDndMonitor({
    onDragEnd(event: DragEndEvent) {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeData = active.data.current as DragItemData | undefined;
      const overData = over.data.current as DragItemData | undefined;
      if (!activeData || !overData) return;
      // Only handle intra-list task reorder
      if (activeData.type !== 'task' || overData.type !== 'task') return;
      if (activeData.listId !== overData.listId || activeData.listId !== selectedListId) return;

      const oldIndex = activeTasks.findIndex((t) => t.id === active.id);
      const newIndex = activeTasks.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...activeTasks];
      const [moved] = newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, moved);
      reorderTasks(newOrder.map((t) => t.id));
    },
  });

  if (!selectedListId || !selectedList) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-zinc-400">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-zinc-300">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <p className="text-sm">Select or create a list to get started</p>
      </div>
    );
  }

  if (isInboxList(selectedList)) {
    return <InboxListView listId={selectedListId} />;
  }

  if (selectedList.type === 'follow-ups') {
    return <FollowUpList listId={selectedListId} listName={selectedList.name} />;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {/* List header */}
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">{selectedList.name}</h2>
            <DropdownMenu
              trigger={
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
                  <circle cx="10" cy="4" r="1.5" />
                  <circle cx="10" cy="10" r="1.5" />
                  <circle cx="10" cy="16" r="1.5" />
                </svg>
              }
              items={[
                { label: bulkMode ? 'Cancel selection' : 'Select', onClick: () => setBulkMode(!bulkMode) },
                { label: 'Sort by date', onClick: () => {} },
                { label: 'Sort by name', onClick: () => {} },
              ]}
            />
          </div>

          {/* Add a task inline */}
          {creating ? (
            <InlineTaskForm
              onSubmit={(data) => { createTask(selectedListId, data); setCreatingTask(false); }}
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
              Add a task
            </button>
          )}

          {/* Bulk action bar */}
          {bulkMode && selectedListId && (
            <BulkActionBar activeTaskIds={activeTasks.map((t) => t.id)} currentListId={selectedListId} />
          )}

          {/* Active tasks */}
          {activeTasks.length === 0 && completedTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
              <p className="text-sm">No tasks yet</p>
            </div>
          ) : bulkMode ? (
            <div>
              {activeTasks.map((task, i) => (
                <TaskCard key={task.id} task={task} index={i} />
              ))}
            </div>
          ) : (
            <SortableContext items={activeTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <div>
                {activeTasks.map((task, i) => (
                  <SortableTaskItem key={task.id} task={task} index={i} listId={selectedListId} />
                ))}
              </div>
            </SortableContext>
          )}

          {/* Completed section */}
          {completedTasks.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                className="flex items-center gap-2 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`transition-transform ${showCompleted ? 'rotate-90' : ''}`}
                >
                  <path d="M6 3l5 5-5 5z" />
                </svg>
                Completed ({completedTasks.length})
              </button>
              {showCompleted && (
                <div>
                  {completedTasks.map((task, i) => (
                    <TaskCard key={task.id} task={task} index={i} />
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
