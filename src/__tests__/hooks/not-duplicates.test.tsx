// @vitest-environment jsdom
// "Not duplicates" on a merge suggestion: the pair must never be suggested
// again — on this device or any other — so it is kept on the list, synced, and
// encrypted like the list's other content.
import { renderHook, waitFor } from '@testing-library/react';
import '../setup-component';
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList, markNotDuplicates } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { useMergeSuggestions } from '../../hooks/use-merge-suggestions';
import { findDuplicateGroups, sanitizeNotDuplicates, MAX_NOT_DUPLICATES } from '../../lib/similarity';
import { encryptEntity, decryptEntity, SENSITIVE_FIELDS } from '../../sync/crypto';
import { runRemoteMigrations } from '../../sync/migrations';
import { SYNC_VERSION } from '../../sync/version';
import { placeholderRow } from '../../lib/placeholder-content';
import { enableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { SyncData } from '../../db/models';

beforeEach(async () => {
  await resetDb();
});

const notDuplicatesOf = async (listId: string) => (await db.taskLists.get(listId))?.notDuplicates;

describe('findDuplicateGroups with pairs marked "not duplicates"', () => {
  const items = [
    { id: 'a', title: 'Comprar leche' },
    { id: 'b', title: 'comprar leche' },
  ];

  it('control: the pair is grouped', () => {
    expect(findDuplicateGroups(items)).toHaveLength(1);
  });

  it('a marked pair is not grouped, whichever order it was stored in', () => {
    expect(findDuplicateGroups(items, { notDuplicates: new Set(['a|b']) })).toEqual([]);
    expect(findDuplicateGroups([...items].reverse(), { notDuplicates: new Set(['a|b']) })).toEqual([]);
  });

  it('a new look-alike still shows, with both of them', () => {
    const groups = findDuplicateGroups([...items, { id: 'c', title: 'Comprar leche!' }], { notDuplicates: new Set(['a|b']) });
    expect(groups).toHaveLength(1);
    expect([...groups[0].ids].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('sanitizeNotDuplicates (the field is untrusted: it comes from sync and backups)', () => {
  it('keeps well-formed pairs, ordered, without repeats', () => {
    expect(sanitizeNotDuplicates(['b|a', 'a|b', 'c|d'])).toEqual(['a|b', 'c|d']);
  });

  it('drops anything else', () => {
    expect(sanitizeNotDuplicates('a|b')).toEqual([]);
    expect(sanitizeNotDuplicates([1, null, 'a', 'a|a', 'a|b|c', '|b', `${'x'.repeat(65)}|b`, 'a b|c'])).toEqual([]);
  });

  it(`keeps the newest ${MAX_NOT_DUPLICATES}`, () => {
    const many = Array.from({ length: MAX_NOT_DUPLICATES + 5 }, (_, i) => `p${i}|q${i}`);
    const kept = sanitizeNotDuplicates(many);
    expect(kept).toHaveLength(MAX_NOT_DUPLICATES);
    expect(kept.at(-1)).toBe(`p${MAX_NOT_DUPLICATES + 4}|q${MAX_NOT_DUPLICATES + 4}`);
  });
});

describe('markNotDuplicates', () => {
  it('stores every pair of the group', async () => {
    const list = await createTaskList('Work');
    await markNotDuplicates(list.id, ['c', 'a', 'b']);
    expect(await notDuplicatesOf(list.id)).toEqual(['a|c', 'b|c', 'a|b']);
  });

  it('records a change with the field stamped, so it syncs', async () => {
    const list = await createTaskList('Work');
    await db.changeLog.clear();
    await markNotDuplicates(list.id, ['a', 'b']);
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0].entityType).toBe('taskList');
    expect(entries[0].data?.notDuplicates).toEqual(['a|b']);
    expect((await db.taskLists.get(list.id))?.fieldTimestamps?.notDuplicates).toBeGreaterThan(0);
  });

  it('a pair already marked writes nothing', async () => {
    const list = await createTaskList('Work');
    await markNotDuplicates(list.id, ['a', 'b']);
    await db.changeLog.clear();
    await markNotDuplicates(list.id, ['b', 'a']);
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('suggestions in a list', { timeout: 15_000 }, () => {
  it('a pair marked "not duplicates" is never suggested again', async () => {
    const list = await createTaskList('Work');
    const a = assertDefined(await createTask(list.id, { title: 'Comprar leche' }));
    const b = assertDefined(await createTask(list.id, { title: 'comprar leche' }));
    const { result } = renderHook(() => useMergeSuggestions(list.id, 'tasks'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await markNotDuplicates(list.id, [a.id, b.id]);
    await waitFor(() => expect(result.current).toHaveLength(0));
  });
});

describe('on the wire, at rest and in the decoy', () => {
  afterEach(() => {
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
  });

  it('is encrypted on the wire with the list name, and decrypts back', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const row = { id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, notDuplicates: ['PAIR_A|PAIR_B'] };
    const encrypted = await encryptEntity(key, row, 'taskList');
    expect(SENSITIVE_FIELDS.taskList).toContain('notDuplicates');
    expect('notDuplicates' in encrypted).toBe(false);
    expect(JSON.stringify(encrypted)).not.toContain('PAIR_A');
    expect((await decryptEntity(key, encrypted, 'taskList')).notDuplicates).toEqual(['PAIR_A|PAIR_B']);
  });

  it('is not on disk in the clear under Paranoid Mode', async () => {
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
    const list = await createTaskList('Work');
    await enableParanoid('not duplicates passphrase 9 lantern');
    await markNotDuplicates(list.id, ['PAIR_A', 'PAIR_B']);

    expect(await notDuplicatesOf(list.id)).toEqual(['PAIR_A|PAIR_B']);
    setMigrationBypass(true);
    try {
      expect(JSON.stringify(await db.taskLists.get(list.id))).not.toContain('PAIR_A');
      expect(JSON.stringify(await db.changeLog.toArray())).not.toContain('PAIR_A');
    } finally {
      setMigrationBypass(false);
    }
  });

  it('the decoy drops it (it would say which real tasks looked alike)', () => {
    expect('notDuplicates' in placeholderRow('taskList', { id: 'l1', name: 'Work', notDuplicates: ['a|b'] })).toBe(false);
  });

  it('the v10 -> v11 migration rewrites nothing', () => {
    expect(SYNC_VERSION).toBeGreaterThanOrEqual(11);
    const lists = [{ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 }];
    const data = { syncVersion: 10, taskLists: lists, tasks: [], subtasks: [], settings: { theme: 'system' } } as unknown as SyncData;
    const migrated = runRemoteMigrations(data, 10, 11);
    expect(migrated.syncVersion).toBe(11);
    expect(migrated.taskLists).toBe(lists);
  });
});
