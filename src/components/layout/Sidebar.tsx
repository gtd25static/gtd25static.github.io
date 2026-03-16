import { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
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
import { useTaskLists, createTaskList, updateTaskList, deleteTaskList, restoreTaskList, reorderTaskLists } from '../../hooks/use-task-lists';
import { toast } from '../ui/Toast';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { Input } from '../ui/Input';
import { DropdownMenu } from '../ui/DropdownMenu';
import { db } from '../../db';
import type { ListType } from '../../db/models';
import { SyncIndicator } from './SyncIndicator';
import { PomodoroBar } from '../pomodoro/PomodoroBar';
import { GIT_COMMIT, MAX_LIST_NAME_LENGTH, isInboxList } from '../../lib/constants';
import { moveTaskToList } from '../../hooks/use-tasks';
import { useSpecialListContext } from '../../hooks/use-special-list';
import { useReviewData } from '../../hooks/use-review-data';

function formatLastReviewed(ts: number): string {
  const diff = Date.now() - ts;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function useAllTaskCounts(listIds: string[]): Map<string, number> {
  const key = listIds.join(',');
  const counts = useLiveQuery(async () => {
    const map = new Map<string, number>();
    await Promise.all(listIds.map(async (id) => {
      const tasks = await db.tasks.where('listId').equals(id).toArray();
      map.set(id, tasks.filter((t) => !t.deletedAt && t.status !== 'done').length);
    }));
    return map;
  }, [key]);
  return counts ?? new Map();
}

function HighlightedName({ name, highlight }: { name: string; highlight: string }) {
  if (!highlight) return <>{name}</>;
  const idx = name.toLowerCase().indexOf(highlight.toLowerCase());
  if (idx === -1) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <mark className="bg-yellow-200 text-inherit dark:bg-yellow-500/30 rounded-sm">{name.slice(idx, idx + highlight.length)}</mark>
      {name.slice(idx + highlight.length)}
    </>
  );
}

function ListItem({ list, selected, onSelect, highlight, focused, count, allLists }: {
  list: { id: string; name: string; type: ListType };
  selected: boolean;
  onSelect: () => void;
  highlight?: string;
  focused?: boolean;
  count: number;
  allLists?: { id: string; name: string; type: ListType }[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [dropHighlight, setDropHighlight] = useState(false);

  const handleSave = () => {
    if (editName.trim() && editName.trim() !== list.name) {
      updateTaskList(list.id, { name: editName.trim().slice(0, MAX_LIST_NAME_LENGTH) });
    }
    setEditingId(null);
  };

  if (editingId === list.id) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="flex items-center gap-3 px-3 py-3.5 md:py-2"
      >
        {list.type === 'follow-ups' ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0 text-zinc-400">
            <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 6.5v4l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0 text-zinc-400">
            <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity={0.15} />
            <path d="M6 10l2.5 2.5L14 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value.slice(0, MAX_LIST_NAME_LENGTH))}
          maxLength={MAX_LIST_NAME_LENGTH}
          className="flex-1 min-w-0 bg-transparent text-base md:text-sm text-zinc-900 outline-none border-b border-accent-500 dark:text-zinc-100"
          autoFocus
          onBlur={handleSave}
          onKeyDown={(e) => {
            // Stop propagation to prevent dnd-kit keyboard sensor from triggering a drag on Enter/Space
            e.stopPropagation();
            if (e.key === 'Escape') { setEditName(list.name); setEditingId(null); }
          }}
        />
      </form>
    );
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropHighlight(false);
    const singleTaskId = e.dataTransfer.getData('application/x-inbox-task');
    const inboxListId = e.dataTransfer.getData('application/x-inbox-all');
    if (singleTaskId) {
      moveTaskToList(singleTaskId, list.id);
      toast(`Moved to ${list.name}`, 'success');
    } else if (inboxListId && allLists) {
      // Move all inbox tasks to this list
      const inboxList = allLists.find((l) => l.id === inboxListId);
      if (inboxList) {
        db.tasks.where('listId').equals(inboxListId).toArray().then((tasks) => {
          const live = tasks.filter((t) => !t.deletedAt && t.status !== 'done');
          live.forEach((t) => moveTaskToList(t.id, list.id));
          toast(`Moved ${live.length} item${live.length !== 1 ? 's' : ''} to ${list.name}`, 'success');
        });
      }
    }
  }

  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('application/x-inbox-task') || e.dataTransfer.types.includes('application/x-inbox-all')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }

  return (
    <div
      data-focus-id={list.id}
      className={`group flex items-center ${dropHighlight ? 'ring-2 ring-accent-500 rounded-lg' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/x-inbox-task') || e.dataTransfer.types.includes('application/x-inbox-all')) {
          setDropHighlight(true);
        }
      }}
      onDragLeave={() => setDropHighlight(false)}
      onDrop={handleDrop}
    >
      <button
        onClick={onSelect}
        className={`flex flex-1 min-w-0 items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm transition-colors ${
          focused
            ? 'ring-2 ring-accent-500/40 dark:ring-accent-400/30'
            : ''
        } ${
          selected
            ? 'bg-accent-50 text-accent-700 font-medium dark:bg-accent-900/20 dark:text-accent-300'
            : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
        }`}
      >
        {list.type === 'follow-ups' ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={selected ? 'text-orange-500' : 'text-zinc-400'}>
            <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 6.5v4l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={selected ? 'text-accent-600' : 'text-zinc-400'}>
            <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity={0.15} />
            <path d="M6 10l2.5 2.5L14 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="flex-1 min-w-0 break-words text-left"><HighlightedName name={list.name} highlight={highlight ?? ''} /></span>
        {count > 0 && (
          <span className="text-xs text-zinc-400">{count}</span>
        )}
      </button>
      <div className="mr-1 md:opacity-0 md:group-hover:opacity-100">
        <DropdownMenu
          trigger={
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
              <circle cx="10" cy="4" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="10" cy="16" r="1.5" />
            </svg>
          }
          items={[
            { label: 'Rename', onClick: () => { setEditingId(list.id); setEditName(list.name); } },
            { label: 'Delete', onClick: () => {
                  if (!confirm('Delete this list and all its tasks?')) return;
                  deleteTaskList(list.id);
                  toast('List deleted', 'info', () => restoreTaskList(list.id));
                }, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

function SortableListItem({ list, selected, onSelect, highlight, focused, count, allLists }: {
  list: { id: string; name: string; type: ListType };
  selected: boolean;
  onSelect: () => void;
  highlight?: string;
  focused?: boolean;
  count: number;
  allLists?: { id: string; name: string; type: ListType }[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ListItem list={list} selected={selected} onSelect={onSelect} highlight={highlight} focused={focused} count={count} allLists={allLists} />
    </div>
  );
}

export function Sidebar() {
  const lists = useTaskLists();
  const { selectedListId, selectList, setSidebarOpen, setSettingsOpen, setTrashOpen, setWeeklyReviewOpen, searchQuery, setSearchQuery } = useAppState(useShallow(s => ({ selectedListId: s.selectedListId, selectList: s.selectList, setSidebarOpen: s.setSidebarOpen, setSettingsOpen: s.setSettingsOpen, setTrashOpen: s.setTrashOpen, setWeeklyReviewOpen: s.setWeeklyReviewOpen, searchQuery: s.searchQuery, setSearchQuery: s.setSearchQuery })));
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ListType>('tasks');
  const searchRef = useRef<HTMLInputElement>(null);

  const { focusedItemId, focusZone } = useAppState(useShallow(s => ({ focusedItemId: s.focusedItemId, focusZone: s.focusZone })));
  const taskCounts = useAllTaskCounts(lists.map((l) => l.id));
  const { warningCount, blockedCount, recurringCount } = useSpecialListContext();
  const specialTotal = warningCount + blockedCount + recurringCount;
  const reviewData = useReviewData();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const filteredLists = searchQuery
    ? lists.filter((l) => l.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : lists;

  const inboxList = filteredLists.find((l) => isInboxList(l));
  const taskLists = filteredLists.filter((l) => l.type === 'tasks' && !isInboxList(l));
  const followUpLists = filteredLists.filter((l) => l.type === 'follow-ups');
  const inboxCount = inboxList ? (taskCounts.get(inboxList.id) ?? 0) : 0;

  function handleDragEnd(group: 'tasks' | 'follow-ups') {
    return (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const sourceList = group === 'tasks' ? taskLists : followUpLists;
      const otherList = group === 'tasks' ? followUpLists : taskLists;
      const oldIndex = sourceList.findIndex((l) => l.id === active.id);
      const newIndex = sourceList.findIndex((l) => l.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...sourceList];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      // Tasks always come first in global order
      const allOrdered = group === 'tasks'
        ? [...reordered, ...otherList]
        : [...otherList, ...reordered];
      reorderTaskLists(allOrdered.map((l) => l.id));
    };
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    const list = await createTaskList(newName.trim().slice(0, MAX_LIST_NAME_LENGTH), newType);
    selectList(list.id);
    setNewName('');
    setNewType('tasks');
    setCreating(false);
  }

  return (
    <aside className="flex h-full w-[280px] flex-col bg-white dark:bg-zinc-900">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          onClick={() => setSidebarOpen(false)}
          className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-400 dark:hover:bg-zinc-800"
          aria-label="Close sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>
        <svg width="24" height="24" viewBox="0 0 32 32" className="shrink-0">
          <rect width="32" height="32" rx="6" fill="#4285f4"/>
          <path d="M8 16l5 5L24 10" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
        <div className="flex flex-col">
          <span className="text-[22px] font-normal leading-tight text-zinc-700 dark:text-zinc-200">GTD25</span>
          <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500">{GIT_COMMIT}</span>
        </div>
        <div className="ml-auto">
          <SyncIndicator />
        </div>
      </div>

      {/* Pomodoro timer */}
      <div className="px-3 pb-2 overflow-hidden">
        <PomodoroBar />
      </div>

      {/* Create button + Settings cog */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-3 rounded-2xl border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-600 dark:text-zinc-200"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-600">
            <path d="M10 4v12M4 10h12" />
          </svg>
          Create
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="ml-auto rounded-full p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          aria-label="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Search box */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-400 pointer-events-none">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            data-search-input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur(); } }}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 py-1.5 pl-8 pr-7 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder:text-zinc-500"
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              aria-label="Clear search"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Create new list */}
      <div className="px-2">
        {creating ? (
          <form
            onSubmit={(e) => { e.preventDefault(); handleCreate(); }}
            className="mx-1 mt-1 mb-2 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800"
          >
            <Input
              placeholder="List name"
              value={newName}
              onChange={(e) => setNewName(e.target.value.slice(0, MAX_LIST_NAME_LENGTH))}
              maxLength={MAX_LIST_NAME_LENGTH}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNewType('tasks')}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                  newType === 'tasks'
                    ? 'bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700'
                }`}
              >
                Tasks
              </button>
              <button
                type="button"
                onClick={() => setNewType('follow-ups')}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                  newType === 'follow-ups'
                    ? 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700'
                }`}
              >
                Follow-ups
              </button>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700">Create</button>
              <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">Cancel</button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-400">
              <path d="M10 4v12M4 10h12" />
            </svg>
            Create new list
          </button>
        )}
      </div>

      {/* Inbox row (visible when items pending) */}
      {inboxList && inboxCount > 0 && (
        <div className="px-2 pb-1">
          <button
            draggable="true"
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-inbox-all', inboxList.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => {
              selectList(inboxList.id);
              setSidebarOpen(false);
            }}
            className={`flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm transition-colors cursor-grab active:cursor-grabbing ${
              selectedListId === inboxList.id
                ? 'bg-accent-50 text-accent-700 font-medium dark:bg-accent-900/20 dark:text-accent-300'
                : 'bg-accent-50/50 text-accent-700 hover:bg-accent-100 dark:bg-accent-900/10 dark:text-accent-300 dark:hover:bg-accent-900/20'
            }`}
          >
            {/* Inbox tray icon */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent-500">
              <path d="M22 12h-6l-2 3H10l-2-3H2" />
              <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
            </svg>
            <span className="flex-1 text-left">Inbox</span>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent-500 px-1.5 text-xs font-medium text-white">
              {inboxCount}
            </span>
          </button>
        </div>
      )}

      {/* Special list counter */}
      {specialTotal > 0 && (
        <div className="px-2 pb-1">
          <button
            onClick={() => {
              selectList('__special__');
              setSidebarOpen(false);
            }}
            className={`flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm transition-colors ${
              selectedListId === '__special__'
                ? 'bg-amber-50 text-amber-700 font-medium dark:bg-amber-900/20 dark:text-amber-300'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={selectedListId === '__special__' ? 'text-amber-500' : 'text-zinc-400'}>
              <path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.7l-4.9 2.5.9-5.5-4-3.9 5.5-.8z" fill="currentColor" />
            </svg>
            <span className="flex-1 text-left">Attention</span>
            <span className="flex items-center gap-1.5 text-xs">
              {warningCount > 0 && (
                <span className="flex items-center gap-0.5 text-amber-500">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 13H1L8 1z" /><rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" /><circle cx="8" cy="12" r="0.9" fill="white" /></svg>
                  {warningCount}
                </span>
              )}
              {blockedCount > 0 && (
                <span className="flex items-center gap-0.5 text-red-500">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 13H1L8 1z" /><rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" /><circle cx="8" cy="12" r="0.9" fill="white" /></svg>
                  {blockedCount}
                </span>
              )}
              {recurringCount > 0 && (
                <span className="flex items-center gap-0.5 text-violet-500">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8a7 7 0 0113.6-2.3M15 8a7 7 0 01-13.6 2.3" strokeLinecap="round" /><path d="M14.6 2v3.7h-3.7M1.4 14v-3.7h3.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  {recurringCount}
                </span>
              )}
            </span>
          </button>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pt-1 scrollbar-thin">
        {/* Task lists section */}
        {taskLists.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Lists</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd('tasks')}>
              <SortableContext items={taskLists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
                {taskLists.map((list) => (
                  <SortableListItem
                    key={list.id}
                    list={list}
                    selected={selectedListId === list.id}
                    onSelect={() => { selectList(list.id); setSidebarOpen(false); }}
                    highlight={searchQuery}
                    focused={focusedItemId === list.id && focusZone === 'sidebar'}
                    count={taskCounts.get(list.id) ?? 0}
                    allLists={lists}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* Follow-ups section */}
        {followUpLists.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center justify-between px-3 py-2 mt-1 border-t border-zinc-200 dark:border-zinc-700">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Follow-ups</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd('follow-ups')}>
              <SortableContext items={followUpLists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
                {followUpLists.map((list) => (
                  <SortableListItem
                    key={list.id}
                    list={list}
                    selected={selectedListId === list.id}
                    onSelect={() => { selectList(list.id); setSidebarOpen(false); }}
                    highlight={searchQuery}
                    focused={focusedItemId === list.id && focusZone === 'sidebar'}
                    count={taskCounts.get(list.id) ?? 0}
                    allLists={lists}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </nav>

      {/* Bottom actions */}
      <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
        <button
          onClick={() => { setWeeklyReviewOpen(true); setSidebarOpen(false); }}
          className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" />
            <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="flex-1 text-left">Weekly Review</span>
          {reviewData?.lastReviewedAt && (
            <span className="text-[10px] text-zinc-400">{formatLastReviewed(reviewData.lastReviewedAt)}</span>
          )}
        </button>
        <button
          onClick={() => setTrashOpen(true)}
          className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          </svg>
          Trash
        </button>
      </div>
    </aside>
  );
}
