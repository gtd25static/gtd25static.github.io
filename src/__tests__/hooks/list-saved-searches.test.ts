import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createTaskList, updateTaskList, saveListSearch, deleteListSearch } from '../../hooks/use-task-lists';
import { applyRemoteEntries } from '../../sync/change-log';
import { encryptEntity, decryptEntity, SENSITIVE_FIELDS } from '../../sync/crypto';
import { runRemoteMigrations } from '../../sync/migrations';
import { placeholderRow } from '../../lib/placeholder-content';
import { MAX_SAVED_SEARCHES } from '../../lib/list-filter';
import { enableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { SyncData } from '../../db/models';

beforeEach(async () => {
  await resetDb();
});

async function savedOf(listId: string) {
  return (await db.taskLists.get(listId))?.savedSearches;
}

describe('saveListSearch / deleteListSearch', () => {
  it('appends trimmed searches in the order saved', async () => {
    const list = await createTaskList('Work');
    await saveListSearch(list.id, '  presupuesto ');
    await saveListSearch(list.id, 'ana');
    expect(await savedOf(list.id)).toEqual(['presupuesto', 'ana']);
  });

  it('ignores a duplicate (case, accents and spacing aside), a blank one and an over-long one', async () => {
    const list = await createTaskList('Work');
    await saveListSearch(list.id, 'Reunión');
    await saveListSearch(list.id, 'reunion');
    await saveListSearch(list.id, '   ');
    await saveListSearch(list.id, 'x'.repeat(101));
    expect(await savedOf(list.id)).toEqual(['Reunión']);
  });

  it(`keeps at most ${MAX_SAVED_SEARCHES} per list`, async () => {
    const list = await createTaskList('Work');
    for (let i = 0; i < MAX_SAVED_SEARCHES + 2; i++) await saveListSearch(list.id, `s${i}`);
    expect(await savedOf(list.id)).toHaveLength(MAX_SAVED_SEARCHES);
  });

  it('deletes the matching search only', async () => {
    const list = await createTaskList('Work');
    await saveListSearch(list.id, 'ana');
    await saveListSearch(list.id, 'luis');
    await deleteListSearch(list.id, 'ANA');
    expect(await savedOf(list.id)).toEqual(['luis']);
  });

  it('records a change with the field stamped, so it syncs', async () => {
    const list = await createTaskList('Work');
    await db.changeLog.clear();
    await saveListSearch(list.id, 'ana');
    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0].entityType).toBe('taskList');
    expect(entries[0].data?.savedSearches).toEqual(['ana']);
    expect((await db.taskLists.get(list.id))?.fieldTimestamps?.savedSearches).toBeGreaterThan(0);
  });

  it('a no-op (duplicate) writes nothing', async () => {
    const list = await createTaskList('Work');
    await saveListSearch(list.id, 'ana');
    await db.changeLog.clear();
    await saveListSearch(list.id, 'Ana');
    await deleteListSearch(list.id, 'never saved');
    expect(await db.changeLog.count()).toBe(0);
  });

  it('a list with no such id is left alone', async () => {
    await saveListSearch('missing', 'ana');
    expect(await db.taskLists.count()).toBe(0);
  });
});

describe('sync of saved searches', () => {
  it("reach another device, and a rename there doesn't clobber them (field-level merge)", async () => {
    const list = await createTaskList('Work');
    await saveListSearch(list.id, 'ana');
    const deviceA = await db.changeLog.toArray();
    const listOnA = (await db.taskLists.get(list.id))!;

    // Device B has the list from before the save, and renames it later.
    await resetDb();
    await db.taskLists.put({ ...listOnA, savedSearches: undefined, fieldTimestamps: { ...listOnA.fieldTimestamps, savedSearches: 0 } });
    await new Promise((r) => setTimeout(r, 5));
    await updateTaskList(list.id, { name: 'Work (renamed)' });
    await applyRemoteEntries(deviceA);

    const merged = await db.taskLists.get(list.id);
    expect(merged?.name).toBe('Work (renamed)');
    expect(merged?.savedSearches).toEqual(['ana']);
  });

  it('are encrypted on the wire with the list name, and decrypt back', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const row = { id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1, savedSearches: ['FIRE_THE_CFO'] };
    const encrypted = await encryptEntity(key, row, 'taskList');
    expect(SENSITIVE_FIELDS.taskList).toContain('savedSearches');
    expect('savedSearches' in encrypted).toBe(false);
    expect(JSON.stringify(encrypted)).not.toContain('FIRE_THE_CFO');
    expect((await decryptEntity(key, encrypted, 'taskList')).savedSearches).toEqual(['FIRE_THE_CFO']);
  });

  it('the v7 -> v8 migration rewrites nothing', () => {
    const lists = [{ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 }];
    const data = { syncVersion: 7, taskLists: lists, tasks: [], subtasks: [], settings: { theme: 'system' } } as unknown as SyncData;
    const migrated = runRemoteMigrations(data, 7, 8);
    expect(migrated.syncVersion).toBe(8);
    expect(migrated.taskLists).toBe(lists);
  });
});

describe('saved searches at rest under Paranoid Mode', () => {
  afterEach(() => {
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
  });

  it('are not on disk in the clear, and read back while unlocked', async () => {
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
    const list = await createTaskList('Work');
    await enableParanoid('saved searches passphrase 9 lantern');
    await saveListSearch(list.id, 'FIRE_THE_CFO');

    expect(await savedOf(list.id)).toEqual(['FIRE_THE_CFO']);
    setMigrationBypass(true);
    try {
      const raw = await db.taskLists.get(list.id);
      expect(raw?.savedSearches).toBeUndefined();
      expect(JSON.stringify(raw)).not.toContain('FIRE_THE_CFO');
      expect(JSON.stringify(await db.changeLog.toArray())).not.toContain('FIRE_THE_CFO');
    } finally {
      setMigrationBypass(false);
    }
  });
});

describe('the placeholder content keeps the chip count, not the words', () => {
  it('replaces each saved search', () => {
    const row = placeholderRow('taskList', { id: 'l1', name: 'Work', savedSearches: ['FIRE_THE_CFO', 'layoffs'] });
    expect(row.savedSearches).toHaveLength(2);
    expect(JSON.stringify(row)).not.toContain('CFO');
    expect(JSON.stringify(row)).not.toContain('layoffs');
  });

  it('drops a malformed value rather than carrying it over', () => {
    expect(placeholderRow('taskList', { id: 'l1', name: 'Work', savedSearches: 'FIRE_THE_CFO' }).savedSearches).toEqual([]);
  });

  it('leaves an absent field absent', () => {
    expect('savedSearches' in placeholderRow('taskList', { id: 'l1', name: 'Work' })).toBe(false);
  });
});
