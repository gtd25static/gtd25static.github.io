import { useState, useEffect } from 'react';
import { useSubtasks, createSubtask, reorderSubtasks } from '../../hooks/use-subtasks';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { SubtaskForm } from './SubtaskForm';
import { SortableSubtaskList } from './SortableSubtaskList';

interface Props {
  taskId: string;
}

export function SubtaskJourney({ taskId }: Props) {
  const subtasks = useSubtasks(taskId);
  const { addingSubtaskToTaskId, setAddingSubtaskToTaskId, focusedItemId, focusZone } = useAppState(useShallow(s => ({ addingSubtaskToTaskId: s.addingSubtaskToTaskId, setAddingSubtaskToTaskId: s.setAddingSubtaskToTaskId, focusedItemId: s.focusedItemId, focusZone: s.focusZone })));
  const addBtnFocused = focusedItemId === `add-subtask-${taskId}` && focusZone === 'main';
  const [adding, setAdding] = useState(false);

  // React to keyboard-triggered subtask creation (Tab key) and cancellation (Esc)
  useEffect(() => {
    if (addingSubtaskToTaskId === taskId && !adding) {
      setAdding(true);
    } else if (addingSubtaskToTaskId !== taskId && adding) {
      setAdding(false);
    }
  }, [addingSubtaskToTaskId, taskId]);

  return (
    <div>
      {subtasks.length > 0 && (
        <>
          {/* Fork curve from parent checkbox to indented subtask branch */}
          {/* Desktop: checkbox center (34px) → branch center (ml-10 + w-5/2 = 50px) */}
          <svg className="hidden md:block" width="60" height="20" viewBox="0 0 60 20" fill="none">
            <path
              d="M 34 0 C 34 14, 50 6, 50 20"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              className="text-zinc-300 dark:text-zinc-600"
            />
          </svg>
          {/* Mobile: checkbox center (34px) → branch center (ml-10 + w-11/2 = 62px) */}
          <svg className="md:hidden" width="72" height="24" viewBox="0 0 72 24" fill="none">
            <path
              d="M 34 0 C 34 16, 62 8, 62 24"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              className="text-zinc-300 dark:text-zinc-600"
            />
          </svg>
          <SortableSubtaskList
            subtasks={subtasks}
            onReorder={(ids) => reorderSubtasks(ids)}
          />
        </>
      )}

      <div className={`mt-1 ${subtasks.length > 0 ? 'ml-[60px]' : 'ml-8'}`}>
        {adding ? (
          <SubtaskForm
            onSubmit={(data) => {
              createSubtask(taskId, data);
              setAdding(false);
              if (addingSubtaskToTaskId === taskId) setAddingSubtaskToTaskId(null);
            }}
            onCancel={() => {
              setAdding(false);
              if (addingSubtaskToTaskId === taskId) setAddingSubtaskToTaskId(null);
            }}
          />
        ) : (
          <button
            data-focus-id={`add-subtask-${taskId}`}
            onClick={() => setAdding(true)}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 ${addBtnFocused ? 'ring-2 ring-accent-500/40 dark:ring-accent-400/30' : ''}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Add subtask
          </button>
        )}
      </div>
    </div>
  );
}
