import { cleanupSoftDeletes, archiveOldCompleted } from '../../sync/conflict-resolution';
import type { SyncData, TaskList, Task, Subtask, Settings } from '../../db/models';

function makeSettings(overrides?: Partial<Settings>): Settings {
  return { theme: 'light', ...overrides };
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

describe('archiveOldCompleted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T12:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('archives done tasks completed >90 days ago', () => {
    const oldCompletedAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      tasks: [makeTask({ id: 't1', status: 'done', completedAt: oldCompletedAt, updatedAt: oldCompletedAt })],
    });
    const result = archiveOldCompleted(data);
    expect(result.tasks[0].archived).toBe(true);
  });

  it('does not archive recently completed tasks', () => {
    const recentCompletedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      tasks: [makeTask({ id: 't1', status: 'done', completedAt: recentCompletedAt, updatedAt: recentCompletedAt })],
    });
    const result = archiveOldCompleted(data);
    expect(result.tasks[0].archived).toBeUndefined();
  });

  it('does not archive non-done tasks', () => {
    const oldDate = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      tasks: [makeTask({ id: 't1', status: 'todo', updatedAt: oldDate })],
    });
    const result = archiveOldCompleted(data);
    expect(result.tasks[0].archived).toBeUndefined();
  });

  it('skips already archived tasks', () => {
    const oldCompletedAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      tasks: [makeTask({ id: 't1', status: 'done', archived: true, completedAt: oldCompletedAt, updatedAt: oldCompletedAt })],
    });
    const result = archiveOldCompleted(data);
    // Should not change updatedAt since it was already archived
    expect(result.tasks[0].archived).toBe(true);
    expect(result.tasks[0].updatedAt).toBe(oldCompletedAt);
  });

  it('uses updatedAt as fallback when completedAt is missing', () => {
    const oldUpdatedAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
    const data = makeSyncData({
      tasks: [makeTask({ id: 't1', status: 'done', updatedAt: oldUpdatedAt })],
    });
    const result = archiveOldCompleted(data);
    expect(result.tasks[0].archived).toBe(true);
  });

  it('does not touch subtasks or task lists', () => {
    const data = makeSyncData({
      taskLists: [makeList({ id: 'l1' })],
      subtasks: [makeSubtask({ id: 's1' })],
    });
    const result = archiveOldCompleted(data);
    expect(result.taskLists).toEqual(data.taskLists);
    expect(result.subtasks).toEqual(data.subtasks);
  });
});
