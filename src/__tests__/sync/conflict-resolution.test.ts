import { cleanupSoftDeletes } from '../../sync/conflict-resolution';
import type { SyncData, TaskList, Task, Subtask, Settings } from '../../db/models';

function makeSettings(overrides?: Partial<Settings>): Settings {
  return { theme: 'light', keyboardShortcuts: {}, ...overrides };
}

function makeList(overrides: Partial<TaskList>): TaskList {
  return { id: 'l1', name: 'List', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1000, ...overrides };
}

function makeTask(overrides: Partial<Task>): Task {
  return { id: 't1', listId: 'l1', title: 'Task', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000, ...overrides };
}

function makeSubtask(overrides: Partial<Subtask>): Subtask {
  return { id: 's1', taskId: 't1', title: 'Sub', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000, ...overrides };
}

function makeSyncData(overrides?: Partial<SyncData>): SyncData {
  return { taskLists: [], tasks: [], subtasks: [], settings: makeSettings(), ...overrides };
}

describe('cleanupSoftDeletes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes entities deleted longer than maxAge ago', () => {
    const oldDeletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      taskLists: [makeList({ id: 'l1', deletedAt: oldDeletedAt })],
      tasks: [makeTask({ id: 't1', deletedAt: oldDeletedAt })],
      subtasks: [makeSubtask({ id: 's1', deletedAt: oldDeletedAt })],
    });
    const cleaned = cleanupSoftDeletes(data);
    expect(cleaned.taskLists).toHaveLength(0);
    expect(cleaned.tasks).toHaveLength(0);
    expect(cleaned.subtasks).toHaveLength(0);
  });

  it('keeps recently deleted entities', () => {
    const recentDeletedAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      taskLists: [makeList({ id: 'l1', deletedAt: recentDeletedAt })],
    });
    const cleaned = cleanupSoftDeletes(data);
    expect(cleaned.taskLists).toHaveLength(1);
  });

  it('keeps non-deleted entities', () => {
    const data = makeSyncData({
      taskLists: [makeList({ id: 'l1' })],
      tasks: [makeTask({ id: 't1' })],
    });
    const cleaned = cleanupSoftDeletes(data);
    expect(cleaned.taskLists).toHaveLength(1);
    expect(cleaned.tasks).toHaveLength(1);
  });
});
