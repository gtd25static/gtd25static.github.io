import { useEffect, useRef } from 'react';
import { useFocusNudgeStore } from '../../stores/focus-nudge';
import { focusTask } from '../../hooks/use-focus';
import { Button } from '../ui/Button';

function labelFor(kind: string): string {
  if (kind === 'overdue') return 'Overdue';
  if (kind === 'due-today') return 'Due today';
  return 'Pending';
}

function hintFor(kind: string): string {
  if (kind === 'overdue') return 'This needs your attention now.';
  if (kind === 'due-today') return 'This is due today.';
  return 'A pending task worth picking up.';
}

export function FocusNudgeToast() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mouseDownTarget = useRef<EventTarget | null>(null);
  const { nudge, dismiss } = useFocusNudgeStore();

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (nudge && !el.open) el.showModal();
    else if (!nudge && el.open) el.close();
  }, [nudge]);

  if (!nudge) return null;

  async function handleFocus() {
    if (!nudge) return;
    await focusTask(nudge.taskId, { subtaskId: nudge.subtaskId });
    dismiss();
  }

  const displayTitle = nudge.subtaskTitle ?? nudge.taskTitle;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="focus-nudge-title"
      onClose={dismiss}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onMouseDown={(e) => {
        mouseDownTarget.current = e.target;
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current && mouseDownTarget.current === dialogRef.current) {
          dismiss();
        }
        mouseDownTarget.current = null;
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/35 backdrop:backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="px-6 py-5">
        <div className="mb-3 inline-flex rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700 dark:bg-accent-950 dark:text-accent-300">
          {labelFor(nudge.kind)}
        </div>
        <h2 id="focus-nudge-title" className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {displayTitle}
        </h2>
        {nudge.subtaskTitle && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            in {nudge.taskTitle}
          </p>
        )}
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {hintFor(nudge.kind)}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={handleFocus}>
            Focus
          </Button>
        </div>
      </div>
    </dialog>
  );
}
