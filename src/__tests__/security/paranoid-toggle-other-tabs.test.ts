import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });

// Turning Paranoid Mode off (or on) while the app is open in more than one tab,
// or while this tab keeps working in the background.
//
// The disable used to destroy the key while another tab still held it: that tab
// went on encrypting rows (a focus refill is enough) under a key nothing could
// read any more, and the list holding them crashed the app on the next load. In
// the disabling tab itself, a background write landing in a table the pass had
// already decrypted was left encrypted the same way.

// Signals sent to the other tabs and decrypt passes, in the order they happen.
const hooks = vi.hoisted(() => ({
  events: [] as string[],
  afterFirstDecryptPass: null as null | (() => Promise<void>),
}));

vi.mock('../../lib/tab-channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tab-channel')>();
  return {
    ...actual,
    signalOtherTabs: (signal: Parameters<typeof actual.signalOtherTabs>[0]) => {
      const flag = localStorage.getItem('gtd25-paranoid') === '1' ? 'up' : 'down';
      hooks.events.push(`signal:${signal.type} flag=${flag}`);
      actual.signalOtherTabs(signal);
    },
  };
});

vi.mock('../../db/vault-migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/vault-migration')>();
  return {
    ...actual,
    decryptAllAtRest: async (...args: Parameters<typeof actual.decryptAllAtRest>) => {
      hooks.events.push('decrypt pass');
      await actual.decryptAllAtRest(...args);
      const hook = hooks.afterFirstDecryptPass;
      hooks.afterFirstDecryptPass = null;
      if (hook) await hook();
    },
  };
});

import type { Task, TaskList } from '../../db/models';

// The setup file already loaded the vault with the real modules; load a fresh
// graph so it picks up the mocks above.
let db: typeof import('../../db').db;
let vault: typeof import('../../db/vault');
let middleware: typeof import('../../db/vault-middleware');
let updateTask: typeof import('../../hooks/use-tasks').updateTask;
let resetDb: typeof import('../helpers/db-helpers').resetDb;

beforeAll(async () => {
  vi.resetModules();
  ({ db } = await import('../../db'));
  vault = await import('../../db/vault');
  vault.__setKdfParamsForTests({ algo: 'argon2id', memKiB: 1024, iterations: 1, parallelism: 1 });
  middleware = await import('../../db/vault-middleware');
  ({ updateTask } = await import('../../hooks/use-tasks'));
  ({ resetDb } = await import('../helpers/db-helpers'));
});

const PASS = 'other tabs passphrase 57 walnut';
const FLAG = 'gtd25-paranoid';

const list = (): TaskList => ({ id: 'l1', name: 'List One', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
const task = (id: string, title: string): Task =>
  ({ id, listId: 'l1', title, status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);

/** Every row of a table exactly as it sits on disk. */
async function rawRows(table: 'tasks' | 'taskLists' | 'changeLog'): Promise<Array<Record<string, unknown>>> {
  middleware.setMigrationBypass(true);
  try {
    return (await db[table].toArray()) as unknown as Array<Record<string, unknown>>;
  } finally {
    middleware.setMigrationBypass(false);
  }
}

/** Rows still carrying at-rest ciphertext (a changelog entry carries it in `data`). */
async function encryptedLeft(): Promise<string[]> {
  const out: string[] = [];
  for (const table of ['taskLists', 'tasks', 'changeLog'] as const) {
    for (const row of await rawRows(table)) {
      const enc = table === 'changeLog' ? (row.data as Record<string, unknown> | undefined)?._enc : row._enc;
      if (enc !== undefined) out.push(`${table}:${String(row.id)}`);
    }
  }
  return out;
}

beforeEach(async () => {
  await resetDb();
  vault.__resetVaultStateForTests();
  localStorage.removeItem(FLAG);
  hooks.events.length = 0;
  hooks.afterFirstDecryptPass = null;
  await db.taskLists.add(list());
  await db.tasks.add(task('t1', 'alpha'));
});

afterEach(() => {
  vault.__resetVaultStateForTests();
  localStorage.removeItem(FLAG);
  hooks.afterFirstDecryptPass = null;
});

describe('disabling Paranoid Mode', () => {
  it('locks the other tabs before the first row is decrypted, and reloads them once Paranoid Mode is off', async () => {
    await vault.enableParanoid(PASS);
    hooks.events.length = 0;

    await vault.disableParanoid();

    expect(hooks.events[0]).toBe('signal:lock flag=up');
    expect(hooks.events).toContain('decrypt pass');
    expect(hooks.events.at(-1)).toBe('signal:reload flag=down');
    expect(await db.vault.get('vault')).toBeUndefined();
  });

  it('a background write landing after its table was decrypted is not left encrypted under the destroyed key', async () => {
    await vault.enableParanoid(PASS);
    // E.g. the focus refill writing a task while the pass works on other tables.
    hooks.afterFirstDecryptPass = async () => { await db.tasks.put(task('late', 'LATE_WRITE')); };

    await vault.disableParanoid();

    expect(await encryptedLeft()).toEqual([]);
    expect((await rawRows('tasks')).find((r) => r.id === 'late')?.title).toBe('LATE_WRITE');
  });

  it('the same for a write that encrypts its rows itself before storing them (task edits, sync)', async () => {
    await vault.enableParanoid(PASS);
    hooks.afterFirstDecryptPass = async () => { await updateTask('t1', { title: 'LATE_EDIT' }); };

    await vault.disableParanoid();

    expect(await encryptedLeft()).toEqual([]);
    expect((await rawRows('tasks')).find((r) => r.id === 't1')?.title).toBe('LATE_EDIT');
  });
});

describe('a tab still holding the key after another tab turned Paranoid Mode off', () => {
  // What the other tab's disable leaves behind: plaintext rows, no vault, no
  // flag — while this tab (which missed the lock signal) still holds the key.
  async function disabledElsewhere(): Promise<void> {
    middleware.setMigrationBypass(true);
    try {
      await db.changeLog.clear();
      await db.taskLists.clear();
      await db.tasks.clear();
      await db.taskLists.add(list());
      await db.tasks.add(task('t1', 'alpha'));
    } finally {
      middleware.setMigrationBypass(false);
    }
    await db.vault.delete('vault');
    localStorage.removeItem(FLAG);
  }

  it('writes plaintext, not rows nothing can decrypt', async () => {
    await vault.enableParanoid(PASS);
    await disabledElsewhere();
    expect(vault.isUnlocked()).toBe(true); // the stale key is still in this tab's memory

    await db.tasks.put(task('t2', 'WRITTEN_AFTER'));   // through the at-rest middleware
    await updateTask('t1', { title: 'EDITED_AFTER' }); // encrypts its rows itself

    expect(await encryptedLeft()).toEqual([]);
    const titles = (await rawRows('tasks')).map((r) => r.title).sort();
    expect(titles).toEqual(['EDITED_AFTER', 'WRITTEN_AFTER']);
  });

  it('refuses a row that was encrypted just before Paranoid Mode went off', async () => {
    await vault.enableParanoid(PASS);
    const sealed = await middleware.encryptRow('tasks', vault.getDEK()!, task('t9', 'SEALED') as unknown as Record<string, unknown>);
    await disabledElsewhere();

    await expect(db.tasks.put(sealed as unknown as Task)).rejects.toThrow();
    expect((await rawRows('tasks')).find((r) => r.id === 't9')).toBeUndefined();
  });
});

describe('rows an older disable left encrypted, on a tab without any key', () => {
  it('can still be deleted (the refusal above is only for a tab holding a stale key)', async () => {
    await vault.enableParanoid(PASS);
    const sealed = await middleware.encryptRow('tasks', vault.getDEK()!, task('t9', 'SEALED') as unknown as Record<string, unknown>);
    vault.__resetVaultStateForTests(); // e.g. after the reload: no key in memory
    localStorage.removeItem(FLAG);
    await db.vault.delete('vault');
    await db.tasks.put(sealed as unknown as Task);

    await db.tasks.update('t9', { deletedAt: 5 });

    expect((await rawRows('tasks')).find((r) => r.id === 't9')?.deletedAt).toBe(5);
  });
});
