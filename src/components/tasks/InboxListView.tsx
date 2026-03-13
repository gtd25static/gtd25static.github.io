import { useTasks } from '../../hooks/use-tasks';
import { InboxCard } from './InboxCard';

interface Props {
  listId: string;
}

export function InboxListView({ listId }: Props) {
  const tasks = useTasks(listId);
  const activeTasks = tasks.filter((t) => t.status !== 'done');

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {/* Header */}
          <div className="mb-1">
            <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">Inbox</h2>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Drag items to a list in the sidebar to process them
            </p>
          </div>

          {/* Inbox items */}
          {activeTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-zinc-300 dark:text-zinc-600">
                <path d="M22 12h-6l-2 3H10l-2-3H2" />
                <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
              </svg>
              <p className="text-sm">Inbox empty</p>
            </div>
          ) : (
            <div>
              {activeTasks.map((task, i) => (
                <InboxCard key={task.id} task={task} index={i} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
