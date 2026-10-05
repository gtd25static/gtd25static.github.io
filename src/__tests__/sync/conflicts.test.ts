import { vi } from 'vitest';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import type { ChangeEntry, Task } from '../../db/models';

// The user-supervised conflict manager (2026-10-05): the same free-text field
// changed on two devices that had not seen each other's change is recorded on
// BOTH devices, nothing blocks (the newer version is applied as before), and the
// user's pick travels as an ordinary edit that closes it everywhere.

vi.mock('../../sync/sync-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/sync-engine')>()),
  scheduleSyncDebounced: vi.fn(),
}));

import { detectConflicts, detectDeleteConflict, conflictSuperseded, effectiveBase, sweepConflicts } from '../../sync/conflicts';
import { applyRemoteEntries } from '../../sync/change-log';
import { resolveConflict } from '../../hooks/use-conflicts';
import { updateTask } from '../../hooks/use-tasks';
import { setVaultKeyProvider, clearVaultKeyProvider, setMigrationBypass } from '../../db/vault-middleware';
import { deriveKey, generateSalt } from '../../sync/crypto';

const T0 = 1_000_000;  // last state both devices had
const TA = 2_000_000;  // device A's edit
const TB = 3_000_000;  // device B's edit

function row(overrides: Partial<Task> & { _base?: Record<string, number> } = {}): Task {
  return {
    id: 't1', listId: 'l1', title: 'Base title', description: 'Base text', status: 'todo', order: 0,
    createdAt: T0, updatedAt: T0,
    fieldTimestamps: { title: T0, description: T0, status: T0, listId: T0, order: T0 },
    _base: { title: T0, description: T0, status: T0, listId: T0, order: T0 },
    ...overrides,
  } as Task;
}

/** A device's row after a local edit of `fields` at `at` (base untouched). */
function edited(base: Task, at: number, fields: Partial<Task>): Task {
  const ft = { ...base.fieldTimestamps };
  for (const k of Object.keys(fields)) ft[k] = at;
  return { ...base, ...fields, updatedAt: at, fieldTimestamps: ft };
}

const asEntity = (t: Task) => t as unknown as Record<string, unknown>;

describe('detection (pure)', () => {
  it('the same title changed on both devices is a conflict — seen from either side', () => {
    const a = edited(row(), TA, { title: 'A title' });
    const b = edited(row(), TB, { title: 'B title' });
    const onB = detectConflicts('task', asEntity(b), asEntity(a), a._base!);
    const onA = detectConflicts('task', asEntity(a), asEntity(b), b._base!);
    for (const found of [onB, onA]) {
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ field: 'title', kind: 'field' });
    }
    expect(onB[0]).toMatchObject({ localValue: 'B title', remoteValue: 'A title', applied: 'local' });
    expect(onA[0]).toMatchObject({ localValue: 'A title', remoteValue: 'B title', applied: 'remote' });
  });

  it('an edit made after seeing the other one is not a conflict', () => {
    const a = edited(row(), TA, { title: 'A title' });
    // B pulled A's edit (its base learned TA), then edited.
    const bSaw = { ...row({ title: 'A title' }), fieldTimestamps: { ...row().fieldTimestamps, title: TA }, _base: { ...row()._base, title: TA } } as Task;
    const b = edited(bSaw, TB, { title: 'B title' });
    expect(detectConflicts('task', asEntity(a), asEntity(b), b._base!)).toEqual([]);
  });

  it('different fields, equal values and scalar fields raise nothing', () => {
    const base = row();
    expect(detectConflicts('task', asEntity(edited(base, TB, { description: 'B' })), asEntity(edited(base, TA, { title: 'A' })), base._base!)).toEqual([]);
    expect(detectConflicts('task', asEntity(edited(base, TB, { title: 'Same' })), asEntity(edited(base, TA, { title: 'Same' })), base._base!)).toEqual([]);
    expect(detectConflicts('task', asEntity(edited(base, TB, { status: 'done' })), asEntity(edited(base, TA, { status: 'todo' as never, order: 3 })), base._base!)).toEqual([]);
  });

  it('a snapshot row (no writer base) counts only against a change of the field not yet pushed', () => {
    const a = edited(row(), TA, { title: 'A title' });
    const b = edited(row(), TB, { title: 'B title' });
    expect(detectConflicts('task', asEntity(b), asEntity(a), null)).toHaveLength(1);
    const bPushed = { ...b, _pushed: { title: TB } } as Task;
    expect(detectConflicts('task', asEntity(bPushed), asEntity(a), null)).toEqual([]);
  });

  it('a row older than `_base` takes its timestamps up to the upgrade as its base (no false conflicts)', () => {
    const old = { ...row(), _base: undefined } as Task;
    expect(effectiveBase(asEntity(old), T0)).toEqual(old.fieldTimestamps);
    const remote = edited(row(), TA, { title: 'A title' });
    // Nothing changed here since the upgrade: the remote edit simply applies.
    expect(detectConflicts('task', asEntity(old), asEntity(remote), remote._base!, { since: T0 })).toEqual([]);
    // Edited here after the upgrade, concurrently with A: a conflict.
    const mine = edited(old, TB, { title: 'B title' });
    expect(detectConflicts('task', asEntity(mine), asEntity(remote), remote._base!, { since: T0 })).toHaveLength(1);
  });

  it('a discussion note edited on both sides is a conflict for that note only', () => {
    const log = [{ id: 'n1', at: T0, note: 'base' }, { id: 'n2', at: T0, note: 'same' }];
    const base = { ...row(), discussionLog: log, fieldTimestamps: { ...row().fieldTimestamps, discussionLog: T0 }, _base: { ...row()._base, discussionLog: T0 } } as Task;
    const a = edited(base, TA, { discussionLog: [{ id: 'n1', at: T0, note: 'A note' }, log[1]] });
    const b = edited(base, TB, { discussionLog: [{ id: 'n1', at: T0, note: 'B note' }, log[1]] });
    const found = detectConflicts('task', asEntity(b), asEntity(a), a._base!);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: 'discussionLog:n1', localValue: 'B note', remoteValue: 'A note' });
  });

  it('deleted there, edited here: a conflict when the edit is not yet pushed', () => {
    const mine = edited(row(), TB, { title: 'B title' });
    expect(detectDeleteConflict('task', asEntity(mine), TA)).toMatchObject({ kind: 'deleted-remotely' });
    const pushed = { ...edited(row(), TA, { title: 'x' }), _pushed: { title: TA } } as Task;
    expect(detectDeleteConflict('task', asEntity(pushed), TB)).toBeNull(); // the deleter may have seen it
    expect(detectDeleteConflict('task', asEntity(row()), TA)).toBeNull(); // nothing edited here
  });

  it('deleted here, edited there (unseen): a conflict', () => {
    const deletedHere = { ...edited(row(), TB, { deletedAt: TB }) } as Task;
    const theirs = edited(row(), TA, { title: 'A title' });
    const found = detectConflicts('task', asEntity(deletedHere), asEntity(theirs), theirs._base!);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'deleted-locally', applied: 'local' });
  });

  it('a conflict no longer stands once the field changed again after both versions', () => {
    const conflict = detectConflicts('task', asEntity(edited(row(), TB, { title: 'B' })), asEntity(edited(row(), TA, { title: 'A' })), row()._base!)[0];
    expect(conflictSuperseded(conflict, asEntity(edited(row(), TB, { title: 'B' })), TB + 1)).toBe(false);
    expect(conflictSuperseded(conflict, asEntity(edited(row(), TB + 5, { title: 'C' })), TB + 10)).toBe(true);
    expect(conflictSuperseded(conflict, undefined)).toBe(true);
  });
});

function entryFrom(device: string, t: Task, at: number): ChangeEntry {
  return { id: `e-${device}-${at}`, deviceId: device, timestamp: at, entityType: 'task', entityId: t.id, operation: 'upsert', data: { ...t } as never, v: 10 };
}

describe('recorded while syncing', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('device B (edit still pending) records the conflict, keeps the newer version applied, and records it once', async () => {
    const mine = edited(row(), TB, { title: 'B title' });
    await db.tasks.put(mine);
    await db.changeLog.add(entryFrom('device-B', mine, TB));
    const theirs = edited(row(), TA, { title: 'A title' });

    await applyRemoteEntries([entryFrom('device-A', theirs, TA)]);
    await applyRemoteEntries([entryFrom('device-A', theirs, TA)]); // every sync re-applies the changelog

    const conflicts = await db.syncConflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ field: 'title', localValue: 'B title', remoteValue: 'A title', applied: 'local', label: 'B title' });
    expect((await db.tasks.get('t1'))!.title).toBe('B title'); // newer (TB) stays applied
  });

  it('device A (its edit already pushed) records it too when B\'s edit arrives', async () => {
    const mine = edited(row(), TA, { title: 'A title' }); // pushed: no pending entry, base still T0
    await db.tasks.put(mine);
    const theirs = edited(row(), TB, { title: 'B title' });

    await applyRemoteEntries([entryFrom('device-B', theirs, TB)]);

    const conflicts = await db.syncConflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ localValue: 'A title', remoteValue: 'B title', applied: 'remote' });
    const saved = await db.tasks.get('t1');
    expect(saved!.title).toBe('B title');
    expect((saved as Task & { _base: Record<string, number> })._base.title).toBe(TB); // the remote state is now known here
  });

  it('a later, informed edit from the other device raises nothing', async () => {
    const mine = edited(row(), TA, { title: 'A title' });
    await db.tasks.put(mine);
    const bSaw = { ...mine, _base: { ...row()._base, title: TA } } as Task;
    const theirs = edited(bSaw, TB, { title: 'B title, after A' });
    await applyRemoteEntries([entryFrom('device-B', theirs, TB)]);
    expect(await db.syncConflicts.count()).toBe(0);
    expect((await db.tasks.get('t1'))!.title).toBe('B title, after A');
  });
});

describe('resolving', () => {
  beforeEach(async () => {
    await resetDb();
    const mine = edited(row(), TA, { title: 'A title' });
    await db.tasks.put(mine);
    await applyRemoteEntries([entryFrom('device-B', edited(row(), TB, { title: 'B title' }), TB)]);
    expect(await db.syncConflicts.count()).toBe(1);
  });

  it('keeping this device\'s version writes it as a new edit (stamped now, recorded for sync) and closes the conflict', async () => {
    const [conflict] = await db.syncConflicts.toArray();
    const before = Date.now();
    await resolveConflict(conflict, { keep: 'local' });
    const saved = await db.tasks.get('t1');
    expect(saved!.title).toBe('A title');
    expect(saved!.fieldTimestamps!.title).toBeGreaterThanOrEqual(before);
    expect(await db.syncConflicts.count()).toBe(0);
    const pending = await db.changeLog.toArray();
    expect(pending).toHaveLength(1);
    expect((pending[0].data as Record<string, unknown>).title).toBe('A title');
  });

  it('a version the user writes is kept', async () => {
    const [conflict] = await db.syncConflicts.toArray();
    await resolveConflict(conflict, { value: 'A and B, merged' });
    expect((await db.tasks.get('t1'))!.title).toBe('A and B, merged');
  });

  it('closes on its own when the field is edited again (here or by the other device\'s choice)', async () => {
    await updateTask('t1', { title: 'Edited after both' });
    expect(await sweepConflicts()).toBe(1);
    expect(await db.syncConflicts.count()).toBe(0);
  });

  it('restore brings back an item deleted on the other device', async () => {
    await db.syncConflicts.clear();
    await db.tasks.put(edited(row({ id: 't9' }), TB, { title: 'Edited here' }));
    await applyRemoteEntries([{ id: 'del', deviceId: 'device-A', timestamp: TA, entityType: 'task', entityId: 't9', operation: 'delete', v: 10 }]);
    const [conflict] = await db.syncConflicts.toArray();
    expect(conflict).toMatchObject({ kind: 'deleted-remotely', applied: 'remote' });
    expect((await db.tasks.get('t9'))!.deletedAt).toBe(TA); // meanwhile in the Trash, as before
    await resolveConflict(conflict, { restore: true });
    const restored = await db.tasks.get('t9');
    expect(restored!.deletedAt).toBeUndefined();
    expect(restored!.title).toBe('Edited here');
    expect(await db.syncConflicts.count()).toBe(0);
  });
});

describe('at rest in Paranoid Mode', () => {
  afterEach(() => {
    clearVaultKeyProvider();
    localStorage.removeItem('gtd25-paranoid');
  });

  it('both versions are stored encrypted', async () => {
    await resetDb();
    const dek = await deriveKey('vault-dek', generateSalt());
    localStorage.setItem('gtd25-paranoid', '1');
    setVaultKeyProvider(() => dek);
    await db.tasks.put(edited(row(), TA, { title: 'SECRET_A' }));
    await applyRemoteEntries([entryFrom('device-B', edited(row(), TB, { title: 'SECRET_B' }), TB)]);

    setMigrationBypass(true);
    try {
      const raw = JSON.stringify(await db.syncConflicts.toArray());
      expect(raw).not.toContain('SECRET_A');
      expect(raw).not.toContain('SECRET_B');
      expect(raw).toContain('_enc');
    } finally {
      setMigrationBypass(false);
    }
    expect((await db.syncConflicts.toArray())[0].remoteValue).toBe('SECRET_B');
  });
});
