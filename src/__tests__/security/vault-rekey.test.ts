import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../helpers/webauthn-mock';
import { setMigrationBypass, decryptRow, type Row } from '../../db/vault-middleware';
import { wrapDek, generateDek } from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithRemoteKey, unlockWithSecurityKey, isUnlocked, getDEK,
  rekeyVault, changePassphrase, checkPassphrase, setSecondaryPassphrase, setVaultSecrets, getVaultSecrets,
  addSecurityKey, listSecurityKeys, wrapDekWithRuk, getRukRaw, getVaultSnapshot, subscribeVault,
  __resetVaultStateForTests,
} from '../../db/vault';
import { createLocalBackup, getLocalBackups, readLocalBackup } from '../../db/backup';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import { clearErrorLog } from '../../lib/diagnostics';
import type { Task, TaskList, Subtask } from '../../db/models';

// Re-keying the vault: a fresh DEK, everything rewritten under it, in one
// transaction, behind the current passphrase — so a key that was copied out of
// this device earlier opens nothing written from now on.

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';
const ROTATED = 'a rotated main passphrase 789';
const WRONG = 'not any passphrase 000';
const TITLE = 'FIRE_THE_CFO on Monday';

async function seedRealContent() {
  await db.taskLists.add({ id: 'l1', name: 'FIRE_THE_CFO list', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: TITLE, description: 'LAYOFF_MEMO_Q3', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'WHISTLEBLOWER contact', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Subtask);
}

/** Rows exactly as they sit on disk (middleware bypassed). */
async function rawRows(table: { toArray: () => Promise<unknown[]> }): Promise<Row[]> {
  setMigrationBypass(true);
  try {
    return (await table.toArray()) as Row[];
  } finally {
    setMigrationBypass(false);
  }
}

/** Every stored byte, raw, plus the safety backups, as one string. */
async function rawDump(): Promise<string> {
  const tables = [db.taskLists, db.tasks, db.subtasks, db.sharedItems, db.sharedBlobs, db.mindmaps, db.mindmapNodes, db.changeLog, db.syncMeta, db.vault, db.localSettings];
  const parts: string[] = [];
  for (const t of tables) {
    const rows = await rawRows(t as unknown as { toArray: () => Promise<unknown[]> });
    parts.push(JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? Array.from(v).join(',') : v)));
  }
  for (const b of getLocalBackups()) parts.push(localStorage.getItem(b.key) ?? '');
  return parts.join('\n');
}

function listeningTab() {
  const channel = new BroadcastChannel('gtd25-tabs');
  const heard: unknown[] = [];
  channel.addEventListener('message', (e) => heard.push((e as MessageEvent).data));
  return { heard, close: () => channel.close() };
}

// resetDb() runs the app's boot sequence, which defers a safety backup by 5 s
// (db/index ensureDefaults). A test here that runs past that — a loaded machine
// is enough — got a backup written mid-test, and the byte-for-byte comparisons
// below saw it as a change. Keep that timer from being scheduled at all.
const BOOT_BACKUP_DELAY_MS = 5000;
async function resetDbWithoutBootBackup(): Promise<void> {
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void, ms?: number, ...args: unknown[]
  ) => (ms === BOOT_BACKUP_DELAY_MS ? undefined : realSetTimeout(handler, ms, ...args))) as unknown as typeof setTimeout);
  try {
    await resetDb();
  } finally {
    spy.mockRestore();
  }
}

async function settle(until?: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    await new Promise((r) => setTimeout(r, 5));
  } while (until && !until() && Date.now() < deadline);
}

beforeEach(async () => {
  await resetDbWithoutBootBackup();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  clearErrorLog();
  localStorage.clear();
  installWebAuthnMock();
  await seedRealContent();
  await enableParanoid(REAL);
  await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
});

describe('rekeyVault rewrites the device under a new key', () => {
  it('every row changes, the old key opens none of it, the content is intact', async () => {
    const oldDek = getDEK()!;
    const before = { lists: await rawRows(db.taskLists), tasks: await rawRows(db.tasks), subs: await rawRows(db.subtasks) };

    await rekeyVault(REAL);

    const after = { lists: await rawRows(db.taskLists), tasks: await rawRows(db.tasks), subs: await rawRows(db.subtasks) };
    expect(after.lists[0]._enc).not.toBe(before.lists[0]._enc);
    expect(after.tasks[0]._enc).not.toBe(before.tasks[0]._enc);
    expect(after.subs[0]._enc).not.toBe(before.subs[0]._enc);
    await expect(decryptRow('tasks', oldDek, after.tasks[0])).rejects.toBeTruthy();
    expect(getDEK()).not.toBe(oldDek);
    expect(await decryptRow('tasks', getDEK()!, after.tasks[0])).toMatchObject({ title: TITLE });
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe(TITLE);
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect((await db.tasks.get('t1'))?.description).toBe('LAYOFF_MEMO_Q3');
  });

  it('keeps the pending changelog, re-encrypted', async () => {
    await db.changeLog.add({ id: 'c1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert', data: { id: 't1', title: TITLE }, v: 7 });
    const [before] = await rawRows(db.changeLog);

    await rekeyVault(REAL);

    const [after] = await rawRows(db.changeLog);
    expect((after.data as Row)._enc).toBeTruthy();
    expect((after.data as Row)._enc).not.toBe((before.data as Row)._enc);
    expect(await db.changeLog.count()).toBe(1);
    expect(((await db.changeLog.get('c1'))?.data as { title?: string })?.title).toBe(TITLE);
  });

  it('re-randomises slot 2: the secondary passphrase has to be set again', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const before = (await db.vault.get('vault'))!.wrappedDek2;

    await rekeyVault(REAL);

    expect((await db.vault.get('vault'))!.wrappedDek2).not.toBe(before);
    expect(await checkPassphrase(SECONDARY)).toBe('none');
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(false);
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    await setSecondaryPassphrase(SECONDARY);
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });

  it('takes a new passphrase, a new salt and Argon2id in the same step', async () => {
    const before = (await db.vault.get('vault'))!;
    await rekeyVault(REAL, ROTATED);
    const after = (await db.vault.get('vault'))!;
    expect(after.passSalt).not.toBe(before.passSalt);
    expect(after.kdf?.algo).toBe('argon2id');
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(false);
    expect(await unlockWithPassphrase(ROTATED)).toBe(true);
  });

  it('upgrades a legacy PBKDF2 vault', async () => {
    await resetDbWithoutBootBackup();
    __resetVaultStateForTests();
    localStorage.clear();
    await seedRealContent(); // plaintext rows: no key was active
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
    // Unlocked while Argon2id can't run, so the unlock-time upgrade fails and the vault stays legacy.
    const realDerive = vaultKdf.deriveVaultKek;
    const spy = vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(
      (pass: string, salt: string, kdf: KdfParams) =>
        kdf.algo === 'argon2id' ? Promise.reject(new Error('wasm blocked')) : realDerive(pass, salt, kdf),
    );
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    spy.mockRestore();
    expect((await db.vault.get('vault'))?.kdf?.algo ?? 'pbkdf2').toBe('pbkdf2');

    await rekeyVault(REAL);

    expect((await db.vault.get('vault'))?.kdf?.algo).toBe('argon2id');
    expect((await rawRows(db.tasks))[0]._enc).toBeTruthy(); // the plaintext rows are encrypted now
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe(TITLE);
  });

  it('carries the secrets over and mints a new verifier', async () => {
    await setVaultSecrets({ githubPat: 'ghp_secret', syncPassword: 'sync pw' });
    const before = (await db.vault.get('vault'))!;

    await rekeyVault(REAL);

    const after = (await db.vault.get('vault'))!;
    expect(after.verifier).not.toBe(before.verifier);
    expect(after.secrets).not.toBe(before.secrets);
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_secret', syncPassword: 'sync pw' });
    lock();
    await unlockWithPassphrase(REAL);
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_secret', syncPassword: 'sync pw' });
  });

  it('keeps remote unlock enrolled under the same remote-unlock key', async () => {
    const ruk = crypto.getRandomValues(new Uint8Array(32));
    const rukCopy = new Uint8Array(ruk);
    await wrapDekWithRuk(ruk);
    const approvers = [{ deviceId: 'phone', name: 'Phone', ecdhPub: { kty: 'EC' } as JsonWebKey, ecdsaPub: { kty: 'EC' } as JsonWebKey }];
    await db.vault.update('vault', { remoteUnlock: { approvers } });
    const before = (await db.vault.get('vault'))!;

    const result = await rekeyVault(REAL);

    const after = (await db.vault.get('vault'))!;
    expect(result.remoteUnlockKept).toBe(true);
    expect(after.dekWrappedByRuk).not.toBe(before.dekWrappedByRuk);
    expect(after.remoteUnlock?.approvers).toEqual(approvers);
    expect(Array.from((await getRukRaw())!)).toEqual(Array.from(rukCopy));
    lock();
    expect(await unlockWithRemoteKey(rukCopy)).toBe(true);
  });

  it('reports remote unlock as not kept when it was never enrolled', async () => {
    const result = await rekeyVault(REAL);
    expect(result.remoteUnlockKept).toBe(false);
    expect((await db.vault.get('vault'))!.dekWrappedByRuk).toBeUndefined();
  });

  it('drops every security key, and says how many', async () => {
    await addSecurityKey('a');
    await addSecurityKey('b');
    expect(await listSecurityKeys()).toHaveLength(2);
    const before = (await db.vault.get('vault'))!;

    const result = await rekeyVault(REAL);

    expect(result.securityKeysDropped).toBe(2);
    expect(await listSecurityKeys()).toEqual([]);
    expect(getVaultSnapshot().hasSecurityKey).toBe(false);
    expect(localStorage.getItem('gtd25-paranoid-key')).toBeNull();
    expect((await db.vault.get('vault'))!.prfSalt).not.toBe(before.prfSalt);
    lock();
    expect(await unlockWithSecurityKey()).toBe(false);
    expect(await unlockWithPassphrase(REAL)).toBe(true);
  });

  it('drops the blob cache and replaces the safety backups with one fresh copy', async () => {
    await db.sharedBlobs.add({ id: 'b1', data: new Uint8Array([1, 2, 3]), cachedAt: 1 });
    await createLocalBackup();
    await new Promise((r) => setTimeout(r, 5));
    await createLocalBackup();
    const oldKeys = getLocalBackups().map((b) => b.key);
    expect(oldKeys).toHaveLength(2);

    await rekeyVault(REAL);

    expect(await db.sharedBlobs.count()).toBe(0);
    const backups = getLocalBackups();
    expect(backups).toHaveLength(1);
    expect(oldKeys).not.toContain(backups[0].key);
    expect((await readLocalBackup(backups[0].key)).tasks[0].title).toBe(TITLE);
  });

  it('tells the other tabs to lock first and to reload once the swap is on disk', async () => {
    const tab = listeningTab();
    try {
      await rekeyVault(REAL);
      await settle(() => tab.heard.length >= 2);
      expect(tab.heard).toEqual([{ type: 'lock' }, { type: 'reload' }]);
    } finally {
      tab.close();
    }
  });

  it('is busy while it runs, and not afterwards', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeVault(() => seen.push(getVaultSnapshot().busy));
    try {
      await rekeyVault(REAL);
    } finally {
      unsubscribe();
    }
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
    expect(getVaultSnapshot().busy).toBe(false);
  });
});

describe('rekeyVault is atomic', () => {
  it('a failure mid-transaction leaves the device byte-for-byte as it was', async () => {
    await setSecondaryPassphrase(SECONDARY);
    await createLocalBackup();
    const oldDek = getDEK()!;
    const before = await rawDump();
    const tab = listeningTab();
    const spy = vi.spyOn(db.vault, 'put').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(rekeyVault(REAL)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    await settle();
    expect(await rawDump()).toBe(before);
    expect(isUnlocked()).toBe(true);
    expect(getDEK()).toBe(oldDek);
    expect(getVaultSnapshot().busy).toBe(false);
    expect(tab.heard).toEqual([{ type: 'lock' }]);
    tab.close();
    expect((await db.tasks.get('t1'))?.title).toBe(TITLE);
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });

  it('ignores a lock arriving while the swap is in flight', async () => {
    const realPut = db.vault.put.bind(db.vault);
    vi.spyOn(db.vault, 'put').mockImplementationOnce((row) => {
      lock(); // idle timer, hotkey or another tab, mid-transaction
      return realPut(row);
    });
    await rekeyVault(REAL);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe(TITLE);
  });
});

describe('rekeyVault needs the main passphrase, and acts on nothing else', () => {
  it('refuses a wrong passphrase and the secondary passphrase alike, changing nothing', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const before = await rawDump();
    const logBefore = (await db.localSettings.get('local'))?.unlockLog ?? [];
    const tab = listeningTab();
    try {
      let wrongMessage = '';
      let secondaryMessage = '';
      await rekeyVault(WRONG).catch((e: Error) => { wrongMessage = e.message; });
      await rekeyVault(SECONDARY).catch((e: Error) => { secondaryMessage = e.message; });
      expect(wrongMessage).toMatch(/Incorrect passphrase/);
      expect(secondaryMessage).toBe(wrongMessage);
      await settle();
      expect(await rawDump()).toBe(before);
      expect((await db.vault.get('vault'))?.failedUnlockAttempts).toBe(0);
      expect((await db.localSettings.get('local'))?.unlockLog ?? []).toEqual(logBefore);
      expect(tab.heard).toEqual([]);
      expect(isUnlocked()).toBe(true);
    } finally {
      tab.close();
    }
  });

  it('refuses while locked, without deriving a key', async () => {
    lock();
    const spy = vi.spyOn(vaultKdf, 'deriveVaultKek');
    await expect(rekeyVault(REAL)).rejects.toThrow(/unlock/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses while an enable or disable is still pending', async () => {
    await db.vault.update('vault', { migrationState: 'encrypting' });
    await expect(rekeyVault(REAL)).rejects.toThrow(/finish/i);
    await db.vault.update('vault', { migrationState: 'done' });
    expect((await db.tasks.get('t1'))?.title).toBe(TITLE);
  });

  it('refuses when a row cannot be read with the current key', async () => {
    setMigrationBypass(true);
    try {
      const raw = (await db.tasks.get('t1')) as unknown as Row;
      await db.tasks.put({ ...raw, _enc: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } as unknown as Task);
    } finally {
      setMigrationBypass(false);
    }
    const before = (await db.vault.get('vault'))!;
    await expect(rekeyVault(REAL)).rejects.toThrow(/can't be read/);
    expect(await db.vault.get('vault')).toEqual(before);
  });
});

describe('changePassphrase', () => {
  it('without re-key: re-wraps only, so the secondary passphrase survives', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const [before] = await rawRows(db.tasks);
    expect(await changePassphrase(REAL, ROTATED, { rekey: false })).toBeNull();
    expect((await rawRows(db.tasks))[0]._enc).toBe(before._enc);
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(false);
    expect(await unlockWithPassphrase(ROTATED)).toBe(true);
  });

  it('with re-key: rewrites everything and re-randomises slot 2', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const [before] = await rawRows(db.tasks);
    const result = await changePassphrase(REAL, ROTATED, { rekey: true });
    expect(result).toEqual({ securityKeysDropped: 0, remoteUnlockKept: false });
    expect((await rawRows(db.tasks))[0]._enc).not.toBe(before._enc);
    expect(await checkPassphrase(SECONDARY)).toBe('none');
    lock();
    expect(await unlockWithPassphrase(ROTATED)).toBe(true);
  });

  it('needs the current passphrase either way', async () => {
    await expect(changePassphrase(WRONG, ROTATED, { rekey: false })).rejects.toThrow(/Incorrect passphrase/);
    await expect(changePassphrase(SECONDARY, ROTATED, { rekey: true })).rejects.toThrow(/Incorrect passphrase/);
    lock();
    expect(await unlockWithPassphrase(ROTATED)).toBe(false);
    expect(await unlockWithPassphrase(REAL)).toBe(true);
  });
});
