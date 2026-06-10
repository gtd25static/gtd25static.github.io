import { type ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { useAppState } from '../../stores/app-state';
import type { Task, Subtask, TaskList } from '../../db/models';
import { newId } from '../../lib/id';

// Reset Zustand app-state store to initial values
export function resetAppState() {
  useAppState.setState({
    selectedListId: null,
    expandedTaskIds: new Set(),
    focusedItemId: null,
    focusZone: 'main',
    editingItemId: null,
    addingSubtaskToTaskId: null,
    creatingTask: false,
    sidebarOpen: true,
    settingsOpen: false,
    helpOpen: false,
    trashOpen: false,
    searchQuery: '',
    navigateToTaskId: null,
    quickCaptureOpen: false,
    bulkMode: false,
    selectedTaskIds: new Set(),
    weeklyReviewOpen: false,
  });
}

// Minimal DndContext wrapper for components that require dnd-kit
export function TestDndWrapper({ children }: { children: ReactNode }) {
  return <DndContext>{children}</DndContext>;
}

// Custom render that sets up user-event and wraps in DndContext
export function renderWithDnd(ui: React.ReactElement, options?: RenderOptions) {
  const user = userEvent.setup();
  const result = render(ui, {
    wrapper: TestDndWrapper,
    ...options,
  });
  return { user, ...result };
}

// Plain render with user-event setup (no DndContext)
export function renderWithUser(ui: React.ReactElement, options?: RenderOptions) {
  const user = userEvent.setup();
  const result = render(ui, options);
  return { user, ...result };
}

// --- Test factories ---

let orderCounter = 0;

export function makeTaskList(overrides: Partial<TaskList> = {}): TaskList {
  const now = Date.now();
  return {
    id: newId(),
    name: 'Test List',
    type: 'tasks',
    order: orderCounter++,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeTask(listId: string, overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: newId(),
    listId,
    title: 'Test Task',
    status: 'todo',
    order: orderCounter++,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeSubtask(taskId: string, overrides: Partial<Subtask> = {}): Subtask {
  const now = Date.now();
  return {
    id: newId(),
    taskId,
    title: 'Test Subtask',
    status: 'todo',
    order: orderCounter++,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Reset order counter between tests
export function resetFactories() {
  orderCounter = 0;
}
