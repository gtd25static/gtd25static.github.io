import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import { wrapDek, generateDek } from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked,
  setSecondaryPassphrase, changePassphrase, __resetVaultStateForTests,
} from '../../db/vault';
import { createLocalBackup } from '../../db/backup';
import { SHARE_CACHE } from '../../lib/share-target';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import { recordError, getErrorLog, clearErrorLog } from '../../lib/diagnostics';
import type { Task, TaskList, Subtask } from '../../db/models';

// Reliability of the secondary passphrase beyond the re-init itself: the paths
// around it that could silently disable it, or leave the real content (or a sign
// of the swap) behind somewhere the re-init's transaction does not reach.

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';
const ROTATED = 'a rotated main passphrase 789';

async function seedRealContent() {
  await db.taskLists.add({ id: 'l1', name: 'FIRE_THE_CFO list', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'FIRE_THE_CFO on Monday', description: 'LAYOFF_MEMO_Q3', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'WHISTLEBLOWER contact', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Subtask);
}

/** Set the secondary passphrase, lock, and unlock with it. */
async function unlockWithSecondary(): Promise<boolean> {
  await setSecondaryPassphrase(SECONDARY);
  lock();
  return unlockWithPassphrase(SECONDARY);
}

// The test localStorage polyfill doesn't enumerate keys via Object.keys.
function backupKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('gtd25-local-backup-')) keys.push(k);
  }
  return keys;
}

async function settle(until?: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    await new Promise((r) => setTimeout(r, 5));
  } while (until && !until() && Date.now() < deadline);
}

/** Another tab of the app, listening on the app's tab channel. */
function listeningTab() {
  const channel = new BroadcastChannel('gtd25-tabs');
  const heard: unknown[] = [];
  channel.addEventListener('message', (e) => heard.push((e as MessageEvent).data));
  return { heard, close: () => channel.close() };
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  clearErrorLog();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
  delete (globalThis as { caches?: unknown }).caches;
});

describe('secondary passphrase survives main-passphrase changes', () => {
  it('still opens (and re-keys) after the main passphrase was changed', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    await changePassphrase(REAL, ROTATED, { rekey: false });
    lock();

    expect(await unlockWithPassphrase(REAL)).toBe(false);    // the rotation itself worked
    expect(await unlockWithPassphrase(ROTATED)).toBe(true);
    lock();

    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    const [task] = await db.tasks.toArray();
    expect(task.title).not.toContain('FIRE_THE_CFO');
  });

  it('refuses to set one on a legacy PBKDF2 vault, whose KDF upgrade would orphan it', async () => {
    // Legacy vault: PBKDF2 wrap and no kdf field. Unlocked while Argon2id can't run,
    // so the unlock-time upgrade fails and the vault stays legacy while unlocked.
    const dek = await generateDek();
    const passSalt = generateSalt();
    await db.vault.put({
      id: 'vault',
      dekWrappedByPass: await wrapDek(await deriveKey(REAL, passSalt), dek),
      passSalt,
      verifier: await createVerifier(dek),
      secrets: await encryptBlob(dek, JSON.stringify({})),
      idleTimeoutMinutes: 15,
      migrationState: 'done',
    });
    localStorage.setItem('gtd25-paranoid', '1');
    const realDerive = vaultKdf.deriveVaultKek;
    const spy = vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(
      (pass: string, salt: string, kdf: KdfParams) =>
        kdf.algo === 'argon2id' ? Promise.reject(new Error('wasm blocked')) : realDerive(pass, salt, kdf),
    );
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    spy.mockRestore();
    expect((await db.vault.get('vault'))?.kdf?.algo ?? 'pbkdf2').toBe('pbkdf2');

    await expect(setSecondaryPassphrase(SECONDARY)).rejects.toThrow(/main passphrase/i);
  });
});

describe('secondary unlock leaves nothing behind outside the database', () => {
  it('destroys the safety backups encrypted under the real key', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await createLocalBackup();
    expect(backupKeys()).toHaveLength(1);

    expect(await unlockWithSecondary()).toBe(true);
    expect(backupKeys()).toEqual([]);
  });

  it('control: a normal unlock keeps the safety backups', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await createLocalBackup();
    lock();

    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect(backupKeys()).toHaveLength(1);
  });

  it('drops a share stashed while locked, so its real content is never offered', async () => {
    const stored = new Set([SHARE_CACHE, 'workbox-precache-v2']);
    (globalThis as { caches?: unknown }).caches = {
      has: async (name: string) => stored.has(name),
      delete: async (name: string) => stored.delete(name),
    };
    await enableParanoid(REAL);

    expect(await unlockWithSecondary()).toBe(true);
    expect(stored.has(SHARE_CACHE)).toBe(false);
    expect(stored.has('workbox-precache-v2')).toBe(true); // the app shell stays
  });

  it('control: a normal unlock keeps the stash, so the share prompt can resume', async () => {
    const stored = new Set([SHARE_CACHE]);
    (globalThis as { caches?: unknown }).caches = {
      has: async (name: string) => stored.has(name),
      delete: async (name: string) => stored.delete(name),
    };
    await enableParanoid(REAL);
    lock();

    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect(stored.has(SHARE_CACHE)).toBe(true);
  });

  it('closes the app notifications still showing real task titles', async () => {
    const close = vi.fn();
    const getNotifications = vi.fn(async () => [{ close }]);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ getNotifications }) } });
    await enableParanoid(REAL);

    expect(await unlockWithSecondary()).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});

describe('secondary unlock leaves no sync history behind', () => {
  it('forgets the repo, the device identity and the sync bookkeeping kept outside the vault', async () => {
    await db.localSettings.update('local', {
      githubRepo: 'me/real-repo',
      changelogPruned: true,
      deviceId: 'device-real',
      deviceIdentity: { ecdsaPub: 'x' } as never,
      deviceName: 'Work laptop',
    });
    localStorage.setItem('gtd25-legacy-checked', '1');
    localStorage.setItem('gtd25-sync-dirty', '1');
    localStorage.setItem('gtd25-backup-daily-at', '123');
    await enableParanoid(REAL);

    expect(await unlockWithSecondary()).toBe(true);
    const local = await db.localSettings.get('local');
    expect(local?.githubRepo).toBeUndefined();
    expect(local?.changelogPruned).toBeUndefined();
    expect(local?.deviceIdentity).toBeUndefined();
    expect(local?.deviceId).toBeTruthy();
    expect(local?.deviceId).not.toBe('device-real');   // the id every real change was stamped with
    expect(local?.deviceName).toBe('Work laptop');     // a label the user picked, not content
    for (const key of ['gtd25-legacy-checked', 'gtd25-sync-dirty', 'gtd25-backup-daily-at']) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
  });

  it('keeps only passphrase entries in the unlock log, since no other method exists afterwards', async () => {
    await enableParanoid(REAL);
    await db.localSettings.update('local', {
      paranoidUnlockLogEnabled: true,
      unlockLog: [
        { at: 1, method: 'securityKey', ok: true },
        { at: 2, method: 'remote', ok: true },
        { at: 3, method: 'passphrase', ok: false },
      ],
    });

    expect(await unlockWithSecondary()).toBe(true);
    const log = (await db.localSettings.get('local'))?.unlockLog ?? [];
    expect(log.every((e) => e.method === 'passphrase')).toBe(true);
    expect(log.map((e) => e.at)).toContain(3);
    expect(log.at(-1)?.ok).toBe(true); // this unlock, as a plain passphrase success
  });

  it('clears the diagnostics log, which records sync activity and remote file names', async () => {
    recordError('sync.pull', new Error('GitHub API error: 502 for gtd25-snapshot.json'));
    await enableParanoid(REAL);

    expect(await unlockWithSecondary()).toBe(true);
    expect(getErrorLog()).toEqual([]);
    expect(localStorage.getItem('gtd25-diagnostics-log')).toBeNull();
  });

  it('a failed re-key is logged without naming the feature', async () => {
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    const spy = vi.spyOn(db.vault, 'put').mockRejectedValueOnce(new Error('disk full'));

    expect(await unlockWithPassphrase(SECONDARY)).toBe(false);
    spy.mockRestore();
    expect(getErrorLog().length).toBeGreaterThan(0);
    expect(getErrorLog().some((e) => /secondary/i.test(e.context))).toBe(false);
  });
});

describe('secondary unlock and other tabs', () => {
  it('locks the other tabs before re-keying, and reloads them once the swap is done', async () => {
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    const other = listeningTab();

    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    await settle(() => other.heard.length >= 2);
    expect(other.heard).toEqual([{ type: 'lock' }, { type: 'reload' }]);
    other.close();
  });

  it('control: a normal unlock sends no signal', async () => {
    await enableParanoid(REAL);
    lock();
    const other = listeningTab();

    expect(await unlockWithPassphrase(REAL)).toBe(true);
    await settle();
    expect(other.heard).toEqual([]);
    other.close();
  });

  it('a lock landing mid re-key cannot copy undecrypted rows into the new vault', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();

    // Another tab's idle lock / hotkey arrives while the re-init is reading.
    const readSubtasks = db.subtasks.toArray.bind(db.subtasks);
    vi.spyOn(db.subtasks, 'toArray').mockImplementationOnce((() => { lock(); return readSubtasks(); }) as never);

    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    // The lock waited for the re-init, then happened; the vault opens as usual.
    expect(isUnlocked()).toBe(false);
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    const [sub] = await db.subtasks.toArray();
    expect((sub as { _decryptError?: boolean })._decryptError).toBeUndefined();
    expect(sub.title).not.toContain('WHISTLEBLOWER');
    expect(sub.taskId).toBe('t1');
  });
});

describe('secondary unlock over imperfect real data', () => {
  it('a row that no longer decrypts does not block it, and the decoy carries no corruption flag', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    setMigrationBypass(true);
    try {
      const raw = (await db.tasks.get('t1')) as unknown as Record<string, unknown>;
      await db.tasks.put({ ...raw, _enc: 'not-a-valid-envelope' } as never);
    } finally {
      setMigrationBypass(false);
    }

    expect(await unlockWithSecondary()).toBe(true);
    expect(isUnlocked()).toBe(true);
    const [task] = await db.tasks.toArray();
    expect((task as { _decryptError?: boolean })._decryptError).toBeUndefined();
    expect(task.title).not.toMatch(/unreadable/);
    expect(task.listId).toBe('l1');
  });
});
