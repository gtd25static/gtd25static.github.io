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
import { useAppState } from '../../stores/app-state';
import { Input } from '../ui/Input';
import { DropdownMenu } from '../ui/DropdownMenu';
import { db } from '../../db';
import type { ListType } from '../../db/models';
import { SyncIndicator } from './SyncIndicator';
import { GIT_COMMIT } from '../../lib/constants';
import { useSpecialList } from '../../hooks/use-special-list';

function useTaskCount(listId: string) {
  return useLiveQuery(async () => {
    const tasks = await db.tasks.where('listId').equals(listId).toArray();
    return tasks.filter((t) => !t.deletedAt && t.status !== 'done').length;
  }, [listId], 0);
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

function ListItem({ list, selected, onSelect, highlight, focused }: {
  list: { id: string; name: string; type: ListType };
  selected: boolean;
  onSelect: () => void;
  highlight?: string;
  focused?: boolean;
}) {
  const count = useTaskCount(list.id);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  if (editingId === list.id) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (editName.trim()) updateTaskList(list.id, { name: editName.trim() });
          setEditingId(null);
        }}
        className="flex items-center gap-1 px-3 py-1"
      >
        <Input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className="flex-1 text-sm"
          autoFocus
          onBlur={() => setEditingId(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null); }}
        />
      </form>
    );
  }

  return (
    <div data-focus-id={list.id} className="group flex items-center">
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

function SortableListItem({ list, selected, onSelect, highlight, focused }: {
  list: { id: string; name: string; type: ListType };
  selected: boolean;
  onSelect: () => void;
  highlight?: string;
  focused?: boolean;
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
      <ListItem list={list} selected={selected} onSelect={onSelect} highlight={highlight} focused={focused} />
    </div>
  );
}

export function Sidebar() {
  const lists = useTaskLists();
  const { selectedListId, selectList, setSidebarOpen, setSettingsOpen, setTrashOpen, searchQuery, setSearchQuery } = useAppState();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ListType>('tasks');
  const searchRef = useRef<HTMLInputElement>(null);

  const { focusedItemId, focusZone } = useAppState();
  const { warningCount, blockedCount, recurringCount } = useSpecialList();
  const specialTotal = warningCount + blockedCount + recurringCount;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const filteredLists = searchQuery
    ? lists.filter((l) => l.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : lists;

  const taskLists = filteredLists.filter((l) => l.type === 'tasks');
  const followUpLists = filteredLists.filter((l) => l.type === 'follow-ups');

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
    const list = await createTaskList(newName.trim(), newType);
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

      {/* Create button */}
      <div className="px-3 pb-2">
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-3 rounded-2xl border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-600 dark:text-zinc-200"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-600">
            <path d="M10 4v12M4 10h12" />
          </svg>
          Create
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
              onChange={(e) => setNewName(e.target.value)}
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
                <span className="text-amber-500">{warningCount}</span>
              )}
              {blockedCount > 0 && (
                <span className="text-red-500">{blockedCount}</span>
              )}
              {recurringCount > 0 && (
                <span className="text-violet-500">{recurringCount}</span>
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
                    onSelect={() => selectList(list.id)}
                    highlight={searchQuery}
                    focused={focusedItemId === list.id && focusZone === 'sidebar'}
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
                    onSelect={() => selectList(list.id)}
                    highlight={searchQuery}
                    focused={focusedItemId === list.id && focusZone === 'sidebar'}
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
          onClick={() => setTrashOpen(true)}
          className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          </svg>
          Trash
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="10" cy="10" r="3" />
            <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
