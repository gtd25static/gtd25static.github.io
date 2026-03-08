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
import type { Subtask } from '../../db/models';
import { setSubtaskStatus } from '../../hooks/use-subtasks';
import { SubtaskItem } from './SubtaskItem';

interface Props {
  subtasks: Subtask[];
  onReorder: (orderedIds: string[]) => void;
}

function SortableItem({ subtask, isFirst, isLast }: { subtask: Subtask; isFirst: boolean; isLast: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  function handleToggleDone(e: React.MouseEvent) {
    e.stopPropagation();
    setSubtaskStatus(subtask.id, subtask.status === 'done' ? 'todo' : 'done');
  }

  return (
    <div ref={setNodeRef} style={style} className="relative flex items-stretch">
      {/* Branch line + commit square */}
      <div
        className="relative flex w-5 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        {/* Vertical line above square */}
        {!isFirst && (
          <div className="absolute left-1/2 top-0 h-1/2 w-[2px] -translate-x-1/2 bg-zinc-300 dark:bg-zinc-600" />
        )}
        {/* Vertical line below square */}
        {!isLast && (
          <div className="absolute left-1/2 top-1/2 bottom-0 w-[2px] -translate-x-1/2 bg-zinc-300 dark:bg-zinc-600" />
        )}
        {/* Clickable commit square */}
        <button
          className="relative z-10"
          onClick={handleToggleDone}
          title={subtask.status === 'done' ? 'Mark incomplete' : 'Mark complete'}
        >
          {subtask.status === 'done' ? (
            <div className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-green-500">
              <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6l2.5 3L9.5 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ) : (
            <div
              className={`h-3.5 w-3.5 rounded-sm border-[1.5px] ${
                subtask.status === 'working'
                  ? 'border-accent-500 bg-accent-500'
                  : subtask.status === 'blocked'
                    ? 'border-red-500 bg-red-500'
                    : 'border-zinc-400 bg-white hover:border-zinc-500 dark:border-zinc-500 dark:bg-zinc-900 dark:hover:border-zinc-400'
              }`}
            />
          )}
        </button>
      </div>
      {/* Subtask content */}
      <div className="flex-1 min-w-0">
        <SubtaskItem subtask={subtask} />
      </div>
    </div>
  );
}

export function SortableSubtaskList({ subtasks, onReorder }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = subtasks.findIndex((s) => s.id === active.id);
    const newIndex = subtasks.findIndex((s) => s.id === over.id);
    const newOrder = [...subtasks];
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);
    onReorder(newOrder.map((s) => s.id));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={subtasks.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="ml-10">
          {subtasks.map((subtask, i) => (
            <SortableItem key={subtask.id} subtask={subtask} isFirst={i === 0} isLast={i === subtasks.length - 1} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
