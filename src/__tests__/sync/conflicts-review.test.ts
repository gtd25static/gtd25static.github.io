import { vi } from 'vitest';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import type { ChangeEntry, Subtask, Task, TaskList } from '../../db/models';

// Final review of the conflict manager (2026-10-05): false conflicts from the
// snapshot path, a later stale edit sweeping a conflict away, note conflicts
// closed by any append, "Restore" that restored nothing visible, stale cards.

vi.mock('../../sync/sync-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/sync-engine')>()),
  scheduleSyncDebounced: vi.fn(),
}));

import { detectConflicts, detectDeleteConflict, conflictSuperseded, sweepConflicts } from '../../sync/conflicts';
import { applyRemoteEntries, notePushedEntries } from '../../sync/change-log';
import { resolveConflict } from '../../hooks/use-conflicts';

const T0 = 1_000_000;
const T1 = 2_000_000;
const T2 = 3_000_000;
const T3 = 4_000_000;

type Row = Task & { _base?: Record<string, number>; _pushed?: Record<string, number> };

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 't1', listId: 'l1', title: 'Base', description: 'Text', status: 'todo', order: 0, createdAt: T0, updatedAt: T0,
    fieldTimestamps: { title: T0, description: T0, status: T0, listId: T0, order: T0 },
    _base: { title: T0, description: T0, status: T0, listId: T0, order: T0 },
    ...overrides,
  } as Row;
}

function edited(base: Row, at: number, fields: Partial<Task>): Row {
  const ft = { ...base.fieldTimestamps };
  for (const k of Object.keys(fields)) ft[k] = at;
  return { ...base, ...fields, updatedAt: at, fieldTimestamps: ft };
}

const asEntity = (t: Row) => t as unknown as Record<string, unknown>;

function entryFrom(device: string, t: Row, at: number): ChangeEntry {
  return { id: `e-${device}-${at}`, deviceId: device, timestamp: at, entityType: 'task', entityId: t.id, operation: 'upsert', data: { ...t } as never, v: 10 };
}

describe('the snapshot path: only an unpushed change of that very field can conflict', () => {
  it('a pending edit of another field (status) does not make the title conflict', () => {
    // Phone renamed (T1, pushed); laptop refined it (T2) after seeing it; compaction.
    const phone = { ...edited(row(), T1, { title: 'call mom' }), _pushed: { title: T1 } };
    const phoneNow = edited(phone, T3, { status: 'done' }); // pending, another field
    const snapshot = { ...edited(row(), T2, { title: 'Call mom re: birthday' }) };
    expect(detectConflicts('task', asEntity(phoneNow), asEntity(snapshot), null)).toEqual([]);
  });

  it('this device\'s own earlier value coming back through compaction is not "another device\'s"', () => {
    const pushed = { ...edited(row(), T1, { title: 'first rename' }), _pushed: { title: T1 } };
    const renamedAgain = edited(pushed, T3, { title: 'second rename' }); // pending
    const snapshot = edited(row(), T1, { title: 'first rename' }); // our T1, compacted
    expect(detectConflicts('task', asEntity(renamedAgain), asEntity(snapshot), null)).toEqual([]);
  });

  it('a genuinely concurrent edit of the same field still conflicts', () => {
    const mine = edited(row(), T3, { title: 'mine, unpushed' });
    const snapshot = edited(row(), T2, { title: 'theirs, compacted' });
    expect(detectConflicts('task', asEntity(mine), asEntity(snapshot), null)).toHaveLength(1);
  });

  it('a delete entry against an edit already pushed is not a conflict (the deleter may have seen it)', () => {
    const pushed = { ...edited(row(), T2, { title: 'edited' }), _pushed: { title: T2 } };
    expect(detectDeleteConflict('task', asEntity(pushed), T1)).toBeNull();
    const unpushed = edited(row(), T2, { title: 'edited' });
    expect(detectDeleteConflict('task', asEntity(unpushed), T3)).toMatchObject({ kind: 'deleted-remotely' });
  });
});

describe('recorded while syncing', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a second stale edit from the same writer updates the conflict instead of letting it vanish', async () => {
    const mine = edited(row(), T1, { title: 'A title' }); // pushed earlier
    await db.tasks.put(mine);
    const b1 = edited(row(), T2, { title: 'B one' });
    const b2 = edited(b1, T3, { title: 'B two' }); // B still has not seen A's
    await applyRemoteEntries([entryFrom('device-B', b1, T2), entryFrom('device-B', b2, T3)]);
    expect(await sweepConflicts()).toBe(0);
    const conflicts = await db.syncConflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ localValue: 'A title', remoteValue: 'B two', remoteAt: T3 });
  });

  it('pushed edits are remembered, so a later snapshot carrying them raises nothing', async () => {
    const mine = edited(row(), T1, { title: 'mine' });
    await db.tasks.put(mine);
    await notePushedEntries([entryFrom('device-A', mine, T1)]);
    const saved = await db.tasks.get('t1') as Row;
    expect(saved._pushed?.title).toBe(T1);
  });

  it('a remote apply that changes nothing writes nothing for a row older than `_base`', async () => {
    const old = { ...row(), _base: undefined } as Row;
    await db.tasks.put(old);
    await db.syncMeta.update('sync-meta', { conflictBaseSince: T0 + 1 });
    const spy = vi.spyOn(db.tasks, 'bulkPut');
    await applyRemoteEntries([entryFrom('device-B', row(), T0)]); // the same state
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('discussion notes', () => {
  it('a new note appended elsewhere does not close a conflict on another note', () => {
    const conflict = {
      id: 'x', entityType: 'task' as const, entityId: 't1', field: 'discussionLog:n1', kind: 'field' as const,
      localValue: 'A note', remoteValue: 'B note', localAt: T1, remoteAt: T2, applied: 'remote' as const, detectedAt: Date.now(),
    };
    const rowNow = { ...row(), discussionLog: [{ id: 'n1', at: T0, note: 'B note' }, { id: 'n2', at: T3, note: 'new' }],
      fieldTimestamps: { ...row().fieldTimestamps, discussionLog: T3 } };
    expect(conflictSuperseded(conflict, asEntity(rowNow as Row))).toBe(false);
    // Resolved (the note gets an editedAt) — or rewritten to a third version: closed.
    const resolved = { ...rowNow, discussionLog: [{ id: 'n1', at: T0, note: 'A note', editedAt: T3 + 1 }] };
    expect(conflictSuperseded(conflict, asEntity(resolved as Row))).toBe(true);
    const rewritten = { ...rowNow, discussionLog: [{ id: 'n1', at: T0, note: 'something else' }] };
    expect(conflictSuperseded(conflict, asEntity(rewritten as Row))).toBe(true);
  });
});

describe('resolving', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('"Restore it" on a subtask brings back its deleted task and list too', async () => {
    await db.taskLists.put({ id: 'l1', name: 'L', type: 'tasks', order: 0, createdAt: T0, updatedAt: T1, deletedAt: T1, fieldTimestamps: { deletedAt: T1 } } as TaskList);
    await db.tasks.put({ ...row(), deletedAt: T1, fieldTimestamps: { ...row().fieldTimestamps, deletedAt: T1 } } as Task);
    await db.subtasks.put({ id: 's1', taskId: 't1', title: 'Edited here', status: 'todo', order: 0, createdAt: T0, updatedAt: T2, deletedAt: T1, fieldTimestamps: { title: T2, deletedAt: T1 } } as Subtask);
    const conflict = {
      id: 'c', entityType: 'subtask' as const, entityId: 's1', field: '', kind: 'deleted-remotely' as const,
      localAt: T2, remoteAt: T1, applied: 'remote' as const, detectedAt: Date.now(),
    };
    await db.syncConflicts.put(conflict);
    await resolveConflict(conflict, { restore: true });
    expect((await db.subtasks.get('s1'))!.deletedAt).toBeUndefined();
    expect((await db.tasks.get('t1'))!.deletedAt).toBeUndefined();
    expect((await db.taskLists.get('l1'))!.deletedAt).toBeUndefined();
    expect(await db.syncConflicts.count()).toBe(0);
  });

  it('a title written by hand is capped like any title, and an empty name is refused', async () => {
    await db.tasks.put(row());
    const conflict = {
      id: 'c', entityType: 'task' as const, entityId: 't1', field: 'title', kind: 'field' as const,
      localValue: 'a', remoteValue: 'b', localAt: T1, remoteAt: T2, applied: 'remote' as const, detectedAt: Date.now(),
    };
    await db.syncConflicts.put(conflict);
    await resolveConflict(conflict, { value: 'x'.repeat(5000) });
    expect((await db.tasks.get('t1'))!.title.length).toBeLessThan(5000);

    await db.taskLists.put({ id: 'l9', name: 'Named', type: 'tasks', order: 0, createdAt: T0, updatedAt: T0 } as TaskList);
    const listConflict = { ...conflict, id: 'c2', entityType: 'taskList' as const, entityId: 'l9', field: 'name' };
    await db.syncConflicts.put(listConflict);
    await resolveConflict(listConflict, { value: '   ' });
    expect((await db.taskLists.get('l9'))!.name).toBe('Named');
    expect(await db.syncConflicts.get('c2')).toBeDefined(); // still open
  });
});
