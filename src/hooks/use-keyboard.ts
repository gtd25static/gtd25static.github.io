import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { setTaskStatus } from './use-tasks';
import { setSubtaskStatus } from './use-subtasks';
import { updateTask, restoreTask } from './use-tasks';
import { sortTasksForDisplay, sortFollowUpsForDisplay } from '../lib/task-sort';
import { deleteTasksBatch } from './use-bulk-operations';
import { toast } from '../components/ui/Toast';
import { confirmDialog } from '../components/ui/ConfirmDialog';
import { RESOLVE_FOLLOW_UP_QUESTION } from '../lib/constants';
import type { ListType } from '../db/models';
import { isParanoidEnabled, isUnlocked, lock } from '../db/vault';

interface NavItem {
  id: string;
  type: 'task' | 'subtask' | 'create' | 'add-subtask';
  taskId?: string;
}

function isActionItem(item: NavItem): boolean {
  return item.type === 'create' || item.type === 'add-subtask';
}

// Controls whose native Enter/Space behaviour (press, follow, toggle) must win
// over the list shortcuts while they hold DOM focus.
const NATIVE_KEY_CONTROLS =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]';

function isNativeKeyControl(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && el.closest(NATIVE_KEY_CONTROLS) !== null;
}

// A modal — a native <dialog> opened with showModal(), or an aria-modal overlay
// — owns the keyboard while it is up.
function isModalOpen(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

export function useKeyboard() {
  const expandedTaskIds = useAppState((s) => s.expandedTaskIds);
  const selectedListId = useAppState((s) => s.selectedListId);
  const focusedItemId = useAppState((s) => s.focusedItemId);

  // Paranoid-extra toggles, readable synchronously from the key handler
  // (preventDefault can't wait for an async read).
  const paranoidHotkeys = useLiveQuery(
    async () => {
      const local = await db.localSettings.get('local');
      return { lock: !!local?.paranoidLockHotkeyEnabled, redact: !!local?.paranoidRedactModeEnabled };
    },
    [],
    { lock: false, redact: false },
  );
  const paranoidHotkeysRef = useRef(paranoidHotkeys);
  paranoidHotkeysRef.current = paranoidHotkeys;

  // Sidebar items
  const lists = useLiveQuery(
    () => db.taskLists.orderBy('order').toArray().then((all) => all.filter((l) => !l.deletedAt && !l.archivedAt)),
    [],
  );

  // Selected list type
  const selectedListType = useLiveQuery(
    async (): Promise<ListType | null> => {
      if (!selectedListId) return null;
      const list = await db.taskLists.get(selectedListId);
      return list?.type ?? null;
    },
    [selectedListId],
    null,
  );

  // Main area navigable items
  const expandedKey = [...expandedTaskIds].sort().join(',');
  const mainItems = useLiveQuery(
    async (): Promise<NavItem[]> => {
      if (!selectedListId) return [];

      const items: NavItem[] = [];

      // Create task/follow-up button
      items.push({ id: 'create-task', type: 'create' });

      // List-specific tasks — use listId index
      const [selectedList, listTasks] = await Promise.all([
        db.taskLists.get(selectedListId),
        db.tasks.where('listId').equals(selectedListId).sortBy('order'),
      ]);
      const isTasksList = selectedList?.type === 'tasks';
      const isFollowUps = selectedList?.type === 'follow-ups';
      const live = listTasks.filter((t) => {
        if (t.deletedAt || t.archived) return false;
        // Follow-ups show all non-archived; task lists hide done
        if (!isFollowUps && t.status === 'done') return false;
        return true;
      });
      // Match visual sort order
      if (isFollowUps) {
        const sorted = sortFollowUpsForDisplay(live);
        live.length = 0;
        live.push(...sorted);
      } else if (isTasksList) {
        const sorted = sortTasksForDisplay(live);
        live.length = 0;
        live.push(...sorted);
      }

      // Load subtasks only for expanded tasks — use taskId index
      const expandedTaskIdsArr = [...expandedTaskIds].filter((id) => live.some((t) => t.id === id));
      const expandedSubs = expandedTaskIdsArr.length > 0
        ? await db.subtasks.where('taskId').anyOf(expandedTaskIdsArr).toArray()
        : [];
      const subsByTask = new Map<string, typeof expandedSubs>();
      for (const s of expandedSubs) {
        if (s.deletedAt) continue;
        const arr = subsByTask.get(s.taskId) ?? [];
        arr.push(s);
        subsByTask.set(s.taskId, arr);
      }

      for (const task of live) {
        items.push({ id: task.id, type: 'task' });
        if (expandedTaskIds.has(task.id)) {
          const subs = (subsByTask.get(task.id) ?? []).sort((a, b) => a.order - b.order);
          for (const sub of subs) {
            items.push({ id: sub.id, type: 'subtask', taskId: task.id });
          }
          if (isTasksList) {
            items.push({ id: `add-subtask-${task.id}`, type: 'add-subtask', taskId: task.id });
          }
        }
      }
      return items;
    },
    [selectedListId, expandedKey],
    [],
  );

  const sidebarItems: NavItem[] = [...(lists ?? []).filter((l) => l.type === 'tasks'), ...(lists ?? []).filter((l) => l.type === 'follow-ups')].map((l) => ({ id: l.id, type: 'task' as const }));

  // Store refs so the event handler always has current values
  const listsRef = useRef(sidebarItems);
  const mainRef = useRef(mainItems);
  const listTypeRef = useRef(selectedListType);
  listsRef.current = sidebarItems;
  mainRef.current = mainItems;
  listTypeRef.current = selectedListType;

  // Scroll focused item into view
  useEffect(() => {
    if (!focusedItemId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-focus-id="${focusedItemId}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [focusedItemId]);

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const s = useAppState.getState();

      // Ctrl+N / Cmd+N: Quick capture (works globally, even in inputs)
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        s.setQuickCaptureOpen(!s.quickCaptureOpen);
        return;
      }

      // Ctrl+Shift+L: instant vault lock (Paranoid extra, opt-in). Global —
      // works from inputs too; when you need it, you need it NOW.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        if (isParanoidEnabled() && isUnlocked() && paranoidHotkeysRef.current.lock) {
          e.preventDefault();
          lock();
        }
        return;
      }

      // Ctrl+Shift+H: toggle the shoulder-surfing redact veil (Paranoid extra).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        if (isParanoidEnabled() && paranoidHotkeysRef.current.redact) {
          e.preventDefault();
          s.setRedacted(!s.redacted);
        }
        return;
      }

      // Skip if modal is open (except Escape to close)
      if (s.quickCaptureOpen) {
        return; // Let QuickCapture handle its own keys
      }

      // Settings and Trash are modal <dialog>s: every key is theirs, and Escape
      // closes them natively — only the topmost dialog, so a confirm or export
      // dialog opened from Settings no longer takes Settings down with it.
      if (s.settingsOpen || s.trashOpen) return;

      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // When in an input field
      if (inInput) {
        if (e.key === 'Escape') {
          // If inside a <dialog>, let browser handle close natively
          if (target.closest('dialog')) return;
          e.preventDefault();
          target.blur();
          s.setEditingItemId(null);
          // Also close any open form/overlay in one press
          if (s.creatingTask) s.setCreatingTask(false);
          if (s.addingSubtaskToTaskId) s.setAddingSubtaskToTaskId(null);
          if (s.searchQuery) s.setSearchQuery('');
        }
        // Ctrl/Cmd+Enter submits the closest form
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const form = target.closest('form');
          if (form) form.requestSubmit();
        }
        return;
      }

      // Everything below binds BARE keys. With Ctrl/Cmd/Alt held this is a
      // browser/system chord (Ctrl+V paste, Ctrl+R reload, Ctrl+L address bar,
      // Ctrl+D bookmark, …) — intercepting the keydown would preventDefault the
      // chord's native action; notably, cancelling Ctrl+V's keydown stops the
      // browser from ever firing the `paste` event the Shared Folder relies on.
      // (Shift stays allowed: '?' and shift-extended j/k selection need it.)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // With a modal up, no shortcut may act on the list behind it, and nothing
      // is preventDefault-ed: cancelling the keydown would stop Escape from
      // closing the <dialog> and Enter/Space from pressing its buttons.
      if (isModalOpen()) {
        if (e.key === '?' && s.helpOpen) {
          // The help overlay is itself a modal; `?` keeps toggling it closed.
          e.preventDefault();
          s.setHelpOpen(false);
        }
        return;
      }

      // Enter/Space on a focused button, link, … press it natively.
      if ((e.key === 'Enter' || e.key === ' ') && isNativeKeyControl(target)) return;

      // Moving the keyboard ring hands Enter/Space back to it: release DOM focus
      // left on a clicked or tabbed-to control (e.g. the sidebar list just
      // clicked), or the next Enter would press that control instead.
      if (['j', 'J', 'k', 'K', 'h', 'l'].includes(e.key) && isNativeKeyControl(document.activeElement)) {
        document.activeElement.blur();
      }

      const items = s.focusZone === 'sidebar' ? listsRef.current : mainRef.current;
      const idx = items.findIndex((i) => i.id === s.focusedItemId);

      switch (e.key) {
        // --- Navigation ---
        case 'j':
        case 'J': {
          e.preventDefault();
          if (items.length === 0) break;
          let newIdx: number;
          if (idx === -1) newIdx = 0;
          else if (idx < items.length - 1) newIdx = idx + 1;
          else break;
          const newItem = items[newIdx];
          s.setFocusedItem(newItem.id);
          // Shift+J in bulk mode: extend selection
          if (e.shiftKey && s.bulkMode && s.focusZone === 'main' && newItem.type === 'task') {
            s.toggleTaskSelected(newItem.id);
          }
          break;
        }
        case 'k':
        case 'K': {
          e.preventDefault();
          if (items.length === 0) break;
          if (idx === 0 && s.focusZone === 'sidebar') {
            const searchInput = document.querySelector('[data-search-input]') as HTMLInputElement | null;
            if (searchInput) searchInput.focus();
            break;
          }
          let newIdx: number;
          if (idx === -1) newIdx = items.length - 1;
          else if (idx > 0) newIdx = idx - 1;
          else break;
          const newItem = items[newIdx];
          s.setFocusedItem(newItem.id);
          // Shift+K in bulk mode: extend selection
          if (e.shiftKey && s.bulkMode && s.focusZone === 'main' && newItem.type === 'task') {
            s.toggleTaskSelected(newItem.id);
          }
          break;
        }
        case 'h': {
          e.preventDefault();
          if (s.focusZone === 'main') {
            s.setFocusZone('sidebar');
            if (s.selectedListId) s.setFocusedItem(s.selectedListId);
            else if (listsRef.current.length > 0) s.setFocusedItem(listsRef.current[0].id);
          }
          break;
        }
        case 'l': {
          e.preventDefault();
          if (s.focusZone === 'sidebar') {
            s.setFocusZone('main');
            if (mainRef.current.length > 0) s.setFocusedItem(mainRef.current[0].id);
          }
          break;
        }

        // --- Actions ---
        case 'Enter': {
          e.preventDefault();
          // Enter: sidebar = select list, main = context-dependent
          if (s.focusZone === 'sidebar' && s.focusedItemId) {
            s.selectList(s.focusedItemId);
            s.setFocusZone('main');
            setTimeout(() => {
              const m = mainRef.current;
              if (m.length > 0) useAppState.getState().setFocusedItem(m[0].id);
            }, 100);
          } else if (s.focusZone === 'main' && s.focusedItemId) {
            const item = mainRef.current.find((i) => i.id === s.focusedItemId);
            if (!item) break;
            if (item.type === 'create') {
              s.setCreatingTask(true);
            } else if (item.type === 'add-subtask') {
              s.ensureTaskExpanded(item.taskId!);
              s.setAddingSubtaskToTaskId(item.taskId!);
            } else if (item.type === 'task' && listTypeRef.current !== 'follow-ups') {
              // A follow-up has nothing to expand, so Enter leaves it alone — it
              // used to silently snooze it (legacy 12h cooldown), hiding the card.
              // Snoozing is the Discussed popover's job.
              s.toggleTaskExpanded(item.id);
            }
          }
          break;
        }

        case ' ': {
          e.preventDefault();
          if (s.focusedItemId && s.focusZone === 'main') {
            // In bulk mode: toggle selection
            if (s.bulkMode) {
              const item = mainRef.current.find((i) => i.id === s.focusedItemId);
              if (item && item.type === 'task') {
                s.toggleTaskSelected(s.focusedItemId);
              }
            } else {
              // Normal: edit focused item title
              const item = mainRef.current.find((i) => i.id === s.focusedItemId);
              if (item && !isActionItem(item)) {
                s.setEditingItemId(s.focusedItemId);
              }
            }
          }
          break;
        }

        case 'Tab': {
          // Tab: create subtask for focused task
          if (s.focusZone === 'main' && s.focusedItemId && listTypeRef.current === 'tasks') {
            const item = mainRef.current.find((i) => i.id === s.focusedItemId);
            if (!item || isActionItem(item)) break;
            const taskId = item.type === 'subtask' ? item.taskId! : item.id;
            e.preventDefault();
            s.ensureTaskExpanded(taskId);
            s.setAddingSubtaskToTaskId(taskId);
          }
          break;
        }

        case 'n': {
          // New task — only in a list: in Focus, Shared, … no form reads the
          // flag, and it used to open later in whichever list came next.
          e.preventDefault();
          if (s.selectedListId && listTypeRef.current) {
            s.setFocusZone('main');
            s.setCreatingTask(true);
          }
          break;
        }

        case 'd': {
          e.preventDefault();
          // Bulk mode: delete selected tasks
          if (s.bulkMode && s.selectedTaskIds.size > 0) {
            const ids = [...s.selectedTaskIds];
            if (!await confirmDialog(
              `Delete ${ids.length} task${ids.length > 1 ? 's' : ''}?`,
              { confirmLabel: 'Delete' },
            )) break;
            s.clearSelection();
            await deleteTasksBatch(ids);
            toast(`${ids.length} task${ids.length > 1 ? 's' : ''} deleted`, 'info', async () => {
              for (const id of ids) await restoreTask(id);
            });
            break;
          }
          // Toggle done — look up directly from DB so it works even after
          // the item has been filtered out of the nav list (e.g. just marked done)
          if (s.focusZone !== 'main' || !s.focusedItemId) break;
          const dItem = mainRef.current.find((i) => i.id === s.focusedItemId);
          if (dItem && isActionItem(dItem)) break;
          if (listTypeRef.current === 'follow-ups') {
            const task = await db.tasks.get(s.focusedItemId);
            if (!task) break;
            // Resolving asks, as the card's Resolve does; reopening doesn't.
            if (!task.archived && !await confirmDialog(RESOLVE_FOLLOW_UP_QUESTION, { confirmLabel: 'Resolve' })) break;
            await updateTask(task.id, { archived: !task.archived });
          } else {
            const task = await db.tasks.get(s.focusedItemId);
            if (task) {
              await setTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
            } else {
              const sub = await db.subtasks.get(s.focusedItemId);
              if (sub) await setSubtaskStatus(sub.id, sub.status === 'done' ? 'todo' : 'done');
            }
          }
          break;
        }

        case 'b': {
          // Toggle blocked — follow-ups have no blocked state.
          e.preventDefault();
          if (s.focusZone !== 'main' || !s.focusedItemId || listTypeRef.current === 'follow-ups') break;
          const item = mainRef.current.find((i) => i.id === s.focusedItemId);
          if (!item || isActionItem(item)) break;
          if (item.type === 'task') {
            const task = await db.tasks.get(item.id);
            if (task) await setTaskStatus(task.id, task.status === 'blocked' ? 'todo' : 'blocked');
          } else {
            const sub = await db.subtasks.get(item.id);
            if (sub) await setSubtaskStatus(sub.id, sub.status === 'blocked' ? 'todo' : 'blocked');
          }
          break;
        }

        case '/': {
          e.preventDefault();
          const searchInput = document.querySelector('[data-search-input]') as HTMLInputElement | null;
          if (searchInput) searchInput.focus();
          break;
        }

        case '?': {
          e.preventDefault();
          s.setHelpOpen(!s.helpOpen);
          break;
        }

        case 'v': {
          // Toggle bulk selection mode
          e.preventDefault();
          if (s.focusZone === 'main') {
            s.setBulkMode(!s.bulkMode);
          }
          break;
        }

        case 's': {
          // Toggle starred
          e.preventDefault();
          if (s.focusZone !== 'main' || !s.focusedItemId) break;
          const sItem = mainRef.current.find((i) => i.id === s.focusedItemId);
          if (!sItem || isActionItem(sItem)) break;
          if (sItem.type === 'task') {
            const task = await db.tasks.get(sItem.id);
            if (task) await updateTask(task.id, { starred: !task.starred });
          }
          break;
        }

        case 'Escape': {
          e.preventDefault();
          // (The help overlay is a modal: its Escape never gets here.)
          if (s.bulkMode) {
            s.clearSelection();
          } else if (s.searchQuery) {
            s.setSearchQuery('');
          } else if (s.creatingTask) {
            s.setCreatingTask(false);
          } else if (s.addingSubtaskToTaskId) {
            s.setAddingSubtaskToTaskId(null);
          } else if (s.editingItemId) {
            s.setEditingItemId(null);
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
