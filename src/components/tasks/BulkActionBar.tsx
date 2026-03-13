import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useTaskLists } from '../../hooks/use-task-lists';
import { deleteTasksBatch, setTaskStatusBatch, moveTasksToListBatch } from '../../hooks/use-bulk-operations';
import { restoreTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { BulkListPicker } from './BulkListPicker';

interface Props {
  activeTaskIds: string[];
  currentListId: string;
}

export function BulkActionBar({ activeTaskIds, currentListId }: Props) {
  const { selectedTaskIds, clearSelection, selectAllTasks } = useAppState(useShallow((s) => ({
    selectedTaskIds: s.selectedTaskIds,
    clearSelection: s.clearSelection,
    selectAllTasks: s.selectAllTasks,
  })));
  const lists = useTaskLists();
  const [showListPicker, setShowListPicker] = useState(false);

  const count = selectedTaskIds.size;
  const otherLists = lists.filter((l) => l.id !== currentListId);

  async function handleDelete() {
    const ids = [...selectedTaskIds];
    clearSelection();
    await deleteTasksBatch(ids);
    toast(`${ids.length} task${ids.length > 1 ? 's' : ''} deleted`, 'info', async () => {
      for (const id of ids) await restoreTask(id);
    });
  }

  async function handleStatus(status: 'done' | 'todo' | 'blocked') {
    const ids = [...selectedTaskIds];
    clearSelection();
    await setTaskStatusBatch(ids, status);
    toast(`${ids.length} task${ids.length > 1 ? 's' : ''} marked ${status}`, 'success');
  }

  async function handleMove(targetListId: string) {
    const ids = [...selectedTaskIds];
    const targetName = lists.find((l) => l.id === targetListId)?.name ?? 'list';
    clearSelection();
    setShowListPicker(false);
    await moveTasksToListBatch(ids, targetListId);
    toast(`${ids.length} task${ids.length > 1 ? 's' : ''} moved to ${targetName}`, 'success');
  }

  return (
    <>
      {/* Desktop bar */}
      <div className="hidden md:flex items-center gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-1.5 text-sm dark:border-accent-800 dark:bg-accent-950/30 mb-2">
        <span className="font-medium text-accent-700 dark:text-accent-300">{count} selected</span>
        <span className="text-zinc-300 dark:text-zinc-600">|</span>
        <button onClick={() => handleStatus('done')} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-accent-100 dark:text-zinc-300 dark:hover:bg-accent-900/40">Done</button>
        <button onClick={() => handleStatus('todo')} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-accent-100 dark:text-zinc-300 dark:hover:bg-accent-900/40">Todo</button>
        <button onClick={() => handleStatus('blocked')} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-accent-100 dark:text-zinc-300 dark:hover:bg-accent-900/40">Block</button>
        <div className="relative">
          <button onClick={() => setShowListPicker(!showListPicker)} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-accent-100 dark:text-zinc-300 dark:hover:bg-accent-900/40">Move</button>
          {showListPicker && (
            <BulkListPicker lists={otherLists} onSelect={handleMove} onClose={() => setShowListPicker(false)} />
          )}
        </div>
        <button onClick={handleDelete} className="rounded px-2 py-0.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">Delete</button>
        <span className="text-zinc-300 dark:text-zinc-600">|</span>
        <button onClick={() => selectAllTasks(activeTaskIds)} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-accent-100 dark:text-zinc-300 dark:hover:bg-accent-900/40">All</button>
        <button onClick={clearSelection} className="rounded px-2 py-0.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
      </div>

      {/* Mobile bottom bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-[90] flex items-center justify-around border-t border-zinc-200 bg-white px-2 py-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
        <span className="text-xs font-medium text-accent-600 dark:text-accent-400">{count}</span>
        <button onClick={() => handleStatus('done')} className="flex flex-col items-center gap-0.5 text-zinc-600 dark:text-zinc-300">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 10l3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="text-[10px]">Done</span>
        </button>
        <button onClick={() => handleStatus('todo')} className="flex flex-col items-center gap-0.5 text-zinc-600 dark:text-zinc-300">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="14" height="14" rx="2" /></svg>
          <span className="text-[10px]">Todo</span>
        </button>
        <button onClick={() => handleStatus('blocked')} className="flex flex-col items-center gap-0.5 text-zinc-600 dark:text-zinc-300">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 10h8" strokeLinecap="round" /></svg>
          <span className="text-[10px]">Block</span>
        </button>
        <div className="relative flex flex-col items-center gap-0.5">
          <button onClick={() => setShowListPicker(!showListPicker)} className="flex flex-col items-center gap-0.5 text-zinc-600 dark:text-zinc-300">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h12M4 10h12M4 14h12" strokeLinecap="round" /></svg>
            <span className="text-[10px]">Move</span>
          </button>
          {showListPicker && (
            <BulkListPicker lists={otherLists} onSelect={handleMove} onClose={() => setShowListPicker(false)} />
          )}
        </div>
        <button onClick={handleDelete} className="flex flex-col items-center gap-0.5 text-red-500">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>
          <span className="text-[10px]">Delete</span>
        </button>
        <button onClick={clearSelection} className="flex flex-col items-center gap-0.5 text-zinc-500">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
          <span className="text-[10px]">Cancel</span>
        </button>
      </div>
    </>
  );
}
