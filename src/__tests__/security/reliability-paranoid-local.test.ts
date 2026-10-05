import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import * as vaultModule from '../../db/vault';
import * as migration from '../../db/vault-migration';
import {
  enableParanoid, disableParanoid, unlockWithPassphrase, lock, isParanoidEnabled, isUnlocked,
  enforceFailedAttemptLimit, UnreadableRowsError, __resetVaultStateForTests,
} from '../../db/vault';
import { createLocalBackup, getLocalBackups, decryptLocalBackups } from '../../db/backup';
import type { Task, TaskList } from '../../db/models';

// Reliability review 2026-10-05, batch C: what an interruption, a full disk or a
// single unreadable row did to a Paranoid device's local state.

const panicSpy = vi.fn();
vi.mock('../../lib/panic-wipe', () => ({ panicWipe: (...a: unknown[]) => panicSpy(...a) }));

const PASS = 'reliability batch c passphrase';

async function seed() {
  await db.taskLists.add({ id: 'l1', name: 'LIST', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'GOOD', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await db.tasks.add({ id: 't2', listId: 'l1', title: 'WILL BE CORRUPT', status: 'todo', order: 1, createdAt: 1, updatedAt: 1 } as Task);
}

/** Damage one stored row's ciphertext, as disk corruption would. */
async function corruptRow(id: string) {
  setMigrationBypass(true);
  try {
    const raw = await db.tasks.get(id) as unknown as Record<string, unknown>;
    const enc = String(raw._enc);
    await db.tasks.put({ ...raw, _enc: enc.slice(0, -6) + (enc.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA') } as never);
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  panicSpy.mockClear();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
});

describe('turning Paranoid Mode off with a row nothing can read', () => {
  it('asks first: refuses before writing anything, then drops only that row when told to', async () => {
    await enableParanoid(PASS);
    await corruptRow('t2');

    await expect(disableParanoid()).rejects.toBeInstanceOf(UnreadableRowsError);
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
    expect(isParanoidEnabled()).toBe(true);

    await disableParanoid({ dropUnreadable: true });
    expect(isParanoidEnabled()).toBe(false);
    expect(await db.vault.get('vault')).toBeUndefined();
    expect((await db.tasks.get('t1'))?.title).toBe('GOOD');
    expect(await db.tasks.get('t2')).toBeUndefined();
  });

  it('a disable interrupted with such a row no longer locks the device out', async () => {
    await enableParanoid(PASS);
    await corruptRow('t2');
    await db.vault.update('vault', { migrationState: 'decrypting' }); // an older disable, cut short
    lock();

    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('GOOD');
  });
});

describe('a resume that fails does not refuse the unlock', () => {
  it('an interrupted enable whose resume fails (full disk) still unlocks, and retries next time', async () => {
    await enableParanoid(PASS);
    await db.vault.update('vault', { migrationState: 'encrypting' });
    lock();
    const spy = vi.spyOn(migration, 'encryptAllAtRest').mockRejectedValueOnce(new Error('Not enough storage'));

    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect((await db.vault.get('vault'))?.migrationState).toBe('encrypting');
    spy.mockRestore();

    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
  });
});

describe('the enable marks itself done last', () => {
  it('cut before the credentials are stripped, it is still pending (and resumes)', async () => {
    await db.localSettings.put({ id: 'local', syncEnabled: true, syncIntervalMs: 300_000, githubPat: 'ghp_PAT', encryptionPassword: 'SYNCPW' });
    const real = db.localSettings.update.bind(db.localSettings);
    let failed = false;
    vi.spyOn(db.localSettings, 'update').mockImplementation(((key: string, changes: Record<string, unknown>) => {
      if (!failed && 'githubPat' in changes && changes.githubPat === undefined) {
        failed = true;
        return Promise.reject(new Error('tab killed'));
      }
      return real(key, changes as never);
    }) as typeof db.localSettings.update);

    await enableParanoid(PASS).catch(() => undefined);
    expect((await db.vault.get('vault'))?.migrationState).toBe('encrypting');
    vi.restoreAllMocks();

    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    const local = await db.localSettings.get('local');
    expect(local?.githubPat).toBeUndefined();
    expect(local?.encryptionPassword).toBeUndefined();
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
  });
});

describe('strict durability', () => {
  it('opens the database with strict transaction durability', () => {
    expect((db as unknown as { _options: { chromeTransactionDurability?: string } })._options.chromeTransactionDurability).toBe('strict');
  });
});

describe('safety copies when storage is full', () => {
  /** A localStorage that holds at most `n` safety copies. */
  function capBackups(n: number) {
    const real = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.startsWith('gtd25-local-backup-')) {
        const present = getLocalBackups().filter((b) => b.key !== key).length;
        if (present >= n) throw new DOMException('full', 'QuotaExceededError');
      }
      real(key, value);
    });
  }

  async function copyAt(ts: number, reason: 'boot' | 'change') {
    vi.spyOn(Date, 'now').mockReturnValue(ts);
    await db.tasks.update('t1', { title: `at ${ts}` });
    const ok = await createLocalBackup({ reason });
    vi.mocked(Date.now).mockRestore();
    return ok;
  }

  it('an app-start copy makes room from older app-start copies only, never the pre-change one', async () => {
    const base = Date.now();
    await copyAt(base - 3000, 'change');
    await copyAt(base - 2000, 'boot');
    capBackups(2);
    expect(await copyAt(base - 1000, 'boot')).toBe(true);
    const keys = getLocalBackups().map((b) => b.timestamp);
    expect(keys).toContain(base - 3000); // the copy taken before the change survives
    expect(keys).toContain(base - 1000);
  });

  it('with only pre-change copies stored, an app-start copy is skipped — and says so', async () => {
    const base = Date.now();
    await copyAt(base - 3000, 'change');
    await copyAt(base - 2000, 'change');
    capBackups(2);
    expect(await copyAt(base - 1000, 'boot')).toBe(false);
    expect(getLocalBackups().map((b) => b.timestamp).sort()).toEqual([base - 3000, base - 2000]);
  });

  it('turning Paranoid off keeps why each copy was taken', async () => {
    await enableParanoid(PASS);
    await createLocalBackup({ reason: 'change' });
    await decryptLocalBackups();
    const key = getLocalBackups()[0].key;
    expect(JSON.parse(localStorage.getItem(key)!).reason).toBe('change');
  });
});

describe('the failed-attempt limit, after a crash', () => {
  it('a count persisted at the limit whose wipe never ran wipes at the next start', async () => {
    await enableParanoid(PASS);
    await db.vault.update('vault', { maxUnlockAttempts: 3, failedUnlockAttempts: 3 });
    __resetVaultStateForTests(); // a reload
    await enforceFailedAttemptLimit();
    expect(panicSpy).toHaveBeenCalledTimes(1);
  });

  it('below the limit, or with the limit off, nothing happens', async () => {
    await enableParanoid(PASS);
    await db.vault.update('vault', { maxUnlockAttempts: 3, failedUnlockAttempts: 2 });
    await enforceFailedAttemptLimit();
    await db.vault.update('vault', { maxUnlockAttempts: 0, failedUnlockAttempts: 9 });
    await enforceFailedAttemptLimit();
    expect(panicSpy).not.toHaveBeenCalled();
  });
});

describe('re-key and the sync lock', () => {
  afterEach(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));

  it('swaps the content while holding the cross-tab sync lock', async () => {
    await enableParanoid(PASS);
    const names: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      value: { request: vi.fn(async (name: string, ...rest: unknown[]) => { names.push(name); return (rest.pop() as () => unknown)(); }) },
      configurable: true,
    });
    await vaultModule.rekeyVault(PASS);
    expect(names).toContain('gtd25-sync');
  });
});

describe('open sync conflicts and the vault key', () => {
  const conflict = {
    id: 'task:t1:title:1:2', entityType: 'task' as const, entityId: 't1', field: 'title', kind: 'field' as const,
    localValue: 'MINE_SECRET', remoteValue: 'THEIRS_SECRET', localAt: 1, remoteAt: 2, applied: 'remote' as const,
    label: 'LABEL_SECRET', detectedAt: Date.now(),
  };

  it('a re-key carries them over under the new key', async () => {
    await enableParanoid(PASS);
    await db.syncConflicts.put(conflict);
    await vaultModule.rekeyVault(PASS);
    const [after] = await db.syncConflicts.toArray();
    expect(after.remoteValue).toBe('THEIRS_SECRET');
  });

  it('the secondary passphrase\'s re-init leaves none behind', async () => {
    await enableParanoid(PASS);
    await vaultModule.setSecondaryPassphrase('the other passphrase 456');
    await db.syncConflicts.put(conflict);
    lock();
    expect(await unlockWithPassphrase('the other passphrase 456')).toBe(true);
    expect(await db.syncConflicts.count()).toBe(0);
  });
});
