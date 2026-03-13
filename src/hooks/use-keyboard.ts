import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useAppState } from '../stores/app-state';
import { setTaskStatus } from './use-tasks';
import { setSubtaskStatus } from './use-subtasks';
import { startWorkingOn, startWorkingOnTask, markWorkingDone, markWorkingBlocked, stopWorking } from './use-working-on';
import { updateTask } from './use-tasks';
import { isInCooldown } from './use-follow-ups';
import type { ListType } from '../db/models';

interface NavItem {
  id: string;
  type: 'task' | 'subtask' | 'banner' | 'banner-blocked' | 'create' | 'add-subtask';
  taskId?: string;
}

function isActionItem(item: NavItem): boolean {
  return item.type === 'banner' || item.type === 'banner-blocked' || item.type === 'create' || item.type === 'add-subtask';
}

export function useKeyboard() {
  const expandedTaskIds = useAppState((s) => s.expandedTaskIds);
  const selectedListId = useAppState((s) => s.selectedListId);
  const focusedItemId = useAppState((s) => s.focusedItemId);

  // Sidebar items
  const lists = useLiveQuery(
    () => db.taskLists.orderBy('order').toArray().then((all) => all.filter((l) => !l.deletedAt)),
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

      // Working-on banner — use indexed status queries
      const [workingTasks, workingSubs] = await Promise.all([
        db.tasks.where('status').equals('working').toArray(),
        db.subtasks.where('status').equals('working').toArray(),
      ]);
      const workingTask = workingTasks.find((t) => !t.deletedAt);
      const workingSub = workingSubs.find((s) => !s.deletedAt);
      if (workingTask || workingSub) {
        items.push({ id: 'banner-working', type: 'banner' });
      }

      // Blocked banner items (up to 5) — use indexed queries
      const [blockedTasks, blockedSubs] = await Promise.all([
        db.tasks.where('status').equals('blocked').toArray(),
        db.subtasks.where('status').equals('blocked').toArray(),
      ]);

      // Build set of task IDs that have blocked subtasks
      const tasksWithBlockedSubs = new Set<string>();
      for (const s of blockedSubs) {
        if (!s.deletedAt) tasksWithBlockedSubs.add(s.taskId);
      }

      // Directly blocked tasks
      const blockedTaskIds = new Set<string>();
      let blockedCount = 0;
      for (const t of blockedTasks) {
        if (blockedCount >= 5) break;
        if (t.deletedAt || t.status === 'done' || t.archived) continue;
        items.push({ id: `banner-blocked-${t.id}`, type: 'banner-blocked', taskId: t.id });
        blockedTaskIds.add(t.id);
        blockedCount++;
      }

      // Tasks with blocked subtasks (not already listed)
      if (blockedCount < 5 && tasksWithBlockedSubs.size > 0) {
        const parentIds = [...tasksWithBlockedSubs].filter((id) => !blockedTaskIds.has(id));
        if (parentIds.length > 0) {
          const parents = await db.tasks.bulkGet(parentIds);
          for (const t of parents) {
            if (blockedCount >= 5) break;
            if (!t || t.deletedAt || t.status === 'done' || t.archived) continue;
            items.push({ id: `banner-blocked-${t.id}`, type: 'banner-blocked', taskId: t.id });
            blockedCount++;
          }
        }
      }

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
      // Match visual sort: follow-ups show not-in-cooldown first
      if (isFollowUps) {
        live.sort((a, b) => {
          const aCool = isInCooldown(a) ? 1 : 0;
          const bCool = isInCooldown(b) ? 1 : 0;
          return aCool - bCool;
        });
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

      // Skip if modal is open (except Escape to close)
      if (s.quickCaptureOpen) {
        return; // Let QuickCapture handle its own keys
      }

      if (s.settingsOpen || s.trashOpen) {
        if (e.key === 'Escape') {
          s.setSettingsOpen(false);
          s.setTrashOpen(false);
        }
        return;
      }

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
          if (s.helpOpen) s.setHelpOpen(false);
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

      const items = s.focusZone === 'sidebar' ? listsRef.current : mainRef.current;
      const idx = items.findIndex((i) => i.id === s.focusedItemId);

      switch (e.key) {
        // --- Navigation ---
        case 'j': {
          e.preventDefault();
          if (items.length === 0) break;
          let newIdx: number;
          if (idx === -1) newIdx = 0;
          else if (idx < items.length - 1) newIdx = idx + 1;
          else break;
          s.setFocusedItem(items[newIdx].id);
          if (items[newIdx].id !== 'banner-working') s.setBannerFocusIndex(0);
          break;
        }
        case 'k': {
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
          s.setFocusedItem(items[newIdx].id);
          if (items[newIdx].id !== 'banner-working') s.setBannerFocusIndex(0);
          break;
        }
        case 'h': {
          e.preventDefault();
          if (s.focusZone === 'main') {
            // Banner sub-navigation: move left through buttons
            if (s.focusedItemId === 'banner-working' && s.bannerFocusIndex > 0) {
              s.setBannerFocusIndex(s.bannerFocusIndex - 1);
            } else {
              s.setBannerFocusIndex(0);
              s.setFocusZone('sidebar');
              if (s.selectedListId) s.setFocusedItem(s.selectedListId);
              else if (listsRef.current.length > 0) s.setFocusedItem(listsRef.current[0].id);
            }
          }
          break;
        }
        case 'l': {
          e.preventDefault();
          if (s.focusZone === 'sidebar') {
            s.setFocusZone('main');
            s.setBannerFocusIndex(0);
            // Skip banner items — land on first content item (create or task)
            const contentItem = mainRef.current.find((i) => i.type !== 'banner' && i.type !== 'banner-blocked');
            if (contentItem) {
              s.setFocusedItem(contentItem.id);
            } else if (mainRef.current.length > 0) {
              s.setFocusedItem(mainRef.current[0].id);
            }
          } else if (s.focusZone === 'main' && s.focusedItemId === 'banner-working') {
            // Move right through banner buttons (0=task, 1=Done, 2=Blocked, 3=Stop)
            if (s.bannerFocusIndex < 3) {
              s.setBannerFocusIndex(s.bannerFocusIndex + 1);
            }
          }
          break;
        }

        // --- Actions ---
        case 'Enter': {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+Enter: start working
            if (s.focusZone === 'main' && s.focusedItemId) {
              const item = mainRef.current.find((i) => i.id === s.focusedItemId);
              if (!item || isActionItem(item)) break;
              if (item.type === 'subtask') {
                await startWorkingOn(item.id);
              } else {
                const subs = await db.subtasks.where('taskId').equals(item.id).toArray();
                const undone = subs.filter((sub) => !sub.deletedAt).find((sub) => sub.status === 'todo' || sub.status === 'blocked');
                if (undone) await startWorkingOn(undone.id);
                else await startWorkingOnTask(item.id);
              }
            }
          } else {
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
              if (item.type === 'banner') {
                const bi = s.bannerFocusIndex;
                if (bi === 0) {
                  // Navigate to working task
                  const wTask = await db.tasks.filter((t) => t.status === 'working' && !t.deletedAt).first();
                  const wSub = await db.subtasks.filter((sub) => sub.status === 'working' && !sub.deletedAt).first();
                  const targetTask = wTask ?? (wSub ? await db.tasks.get(wSub.taskId) : null);
                  if (targetTask) {
                    s.selectList(targetTask.listId);
                    s.ensureTaskExpanded(targetTask.id);
                    s.setFocusedItem(targetTask.id);
                    s.setBannerFocusIndex(0);
                  }
                } else if (bi === 1) {
                  await markWorkingDone();
                } else if (bi === 2) {
                  await markWorkingBlocked();
                } else if (bi === 3) {
                  await stopWorking();
                }
              } else if (item.type === 'banner-blocked') {
                // Navigate to blocked task
                const task = await db.tasks.get(item.taskId!);
                if (task) {
                  s.selectList(task.listId);
                  s.ensureTaskExpanded(task.id);
                  s.setFocusedItem(task.id);
                }
              } else if (item.type === 'create') {
                s.setCreatingTask(true);
              } else if (item.type === 'add-subtask') {
                s.ensureTaskExpanded(item.taskId!);
                s.setAddingSubtaskToTaskId(item.taskId!);
              } else if (listTypeRef.current === 'follow-ups') {
                // Ping toggle for follow-ups
                const task = await db.tasks.get(item.id);
                if (task) {
                  if (isInCooldown(task)) {
                    await updateTask(task.id, { pingedAt: undefined });
                  } else {
                    await updateTask(task.id, { pingedAt: Date.now(), pingCooldown: task.pingCooldown ?? '12h' });
                  }
                }
              } else if (item.type === 'task') {
                s.toggleTaskExpanded(item.id);
              }
            }
          }
          break;
        }

        case ' ': {
          // Space: edit focused item title
          e.preventDefault();
          if (s.focusedItemId && s.focusZone === 'main') {
            const item = mainRef.current.find((i) => i.id === s.focusedItemId);
            if (item && !isActionItem(item)) {
              s.setEditingItemId(s.focusedItemId);
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
          // New task
          e.preventDefault();
          if (s.selectedListId) {
            s.setFocusZone('main');
            s.setCreatingTask(true);
          }
          break;
        }

        case 'd': {
          // Toggle done — look up directly from DB so it works even after
          // the item has been filtered out of the nav list (e.g. just marked done)
          e.preventDefault();
          if (s.focusZone !== 'main' || !s.focusedItemId) break;
          const dItem = mainRef.current.find((i) => i.id === s.focusedItemId);
          if (dItem && isActionItem(dItem)) break;
          if (listTypeRef.current === 'follow-ups') {
            const task = await db.tasks.get(s.focusedItemId);
            if (task) await updateTask(task.id, { archived: !task.archived });
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
          // Toggle blocked
          e.preventDefault();
          if (s.focusZone !== 'main' || !s.focusedItemId) break;
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

        case 'w': {
          // Start working
          e.preventDefault();
          if (s.focusZone !== 'main' || !s.focusedItemId) break;
          const item = mainRef.current.find((i) => i.id === s.focusedItemId);
          if (!item || isActionItem(item)) break;
          if (item.type === 'subtask') {
            await startWorkingOn(item.id);
          } else {
            const subs = await db.subtasks.where('taskId').equals(item.id).toArray();
            const undone = subs.filter((sub) => !sub.deletedAt).find((sub) => sub.status === 'todo' || sub.status === 'blocked');
            if (undone) await startWorkingOn(undone.id);
            else await startWorkingOnTask(item.id);
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

        case 'Escape': {
          e.preventDefault();
          if (s.helpOpen) {
            s.setHelpOpen(false);
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
