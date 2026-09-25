import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { wrapDek, generateDek } from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, encryptBlob } from '../../sync/crypto';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked, confirmCurrentPassphrase, checkPassphrase,
  setSecondaryPassphrase, rekeyVault, changePassphrase, __resetVaultStateForTests,
} from '../../db/vault';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import type { Task, TaskList } from '../../db/models';

// The passphrase is stored trimmed — enable and every change of passphrase have
// trimmed it since the first version — but typing it back was compared exactly.
// A trailing space (phone keyboards add one) read "Incorrect passphrase" and
// counted toward the failed-attempt wipe. Every check now tries the passphrase
// as typed, then trimmed if that differs, as ONE attempt.

const MAIN = 'violet anchor 83 drift quartz lantern';
const SECONDARY = 'copper meadow 41 silent harbor thistle';
const WRONG = 'not the passphrase at all 000';

async function vaultRow() {
  return (await db.vault.get('vault'))!;
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
  await db.taskLists.add({ id: 'l1', name: 'REAL list', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'REAL_TITLE', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await enableParanoid(MAIN);
  await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
});

describe('the lock screen', () => {
  it('opens with a trailing space, and counts nothing', async () => {
    lock();

    expect(await unlockWithPassphrase(`${MAIN} `)).toBe(true);

    expect((await vaultRow()).failedUnlockAttempts ?? 0).toBe(0);
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_TITLE');
  });

  it('opens with surrounding whitespace of any kind', async () => {
    for (const typed of [`  ${MAIN}`, `${MAIN}\n`, `\t${MAIN}  `]) {
      lock();
      expect(await unlockWithPassphrase(typed)).toBe(true);
    }
  });

  it('counts a wrong passphrase with a trailing space as ONE failed attempt (one log entry)', async () => {
    lock();

    expect(await unlockWithPassphrase(`${WRONG} `)).toBe(false);

    expect((await vaultRow()).failedUnlockAttempts).toBe(1);
    const log = (await db.localSettings.get('local'))?.unlockLog ?? [];
    expect(log.filter((e) => !e.ok)).toHaveLength(1);
  });

  it('opens the secondary passphrase with a trailing space too (its separate workspace)', async () => {
    await setSecondaryPassphrase(SECONDARY);
    lock();

    expect(await unlockWithPassphrase(`${SECONDARY} `)).toBe(true);

    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.toArray()).map((t) => t.title)).not.toContain('REAL_TITLE');
  });

  it('still opens a passphrase that really has surrounding spaces, exactly as typed', async () => {
    // Never produced by this app (it has always trimmed at enable), but cheap to keep.
    await resetDb();
    __resetVaultStateForTests();
    localStorage.clear();
    await enableParanoid(`  ${MAIN}  `);
    lock();

    expect(await unlockWithPassphrase(`  ${MAIN}  `)).toBe(true);
  });

  it('upgrades a legacy vault under the passphrase itself, not the stray space', async () => {
    await resetDb();
    __resetVaultStateForTests();
    localStorage.clear();
    const dek = await generateDek();
    const passSalt = generateSalt();
    await db.vault.put({
      id: 'vault',
      dekWrappedByPass: await wrapDek(await deriveKey(MAIN, passSalt), dek),
      passSalt,
      verifier: await createVerifier(dek),
      secrets: await encryptBlob(dek, JSON.stringify({})),
      idleTimeoutMinutes: 15,
      migrationState: 'done',
    });
    localStorage.setItem('gtd25-paranoid', '1');

    expect(await unlockWithPassphrase(`${MAIN} `)).toBe(true);
    expect((await vaultRow()).kdf?.algo).toBe('argon2id');

    lock();
    expect(await unlockWithPassphrase(MAIN)).toBe(true);
  });
});

describe('the passphrase gate, the Check, and the re-key', () => {
  it('the gate accepts the main passphrase with a trailing space, and still refuses the secondary', async () => {
    await setSecondaryPassphrase(SECONDARY);

    expect(await confirmCurrentPassphrase(`${MAIN} `)).toBe(true);
    expect(await confirmCurrentPassphrase(`${SECONDARY} `)).toBe(false);
    expect(await confirmCurrentPassphrase(`${WRONG} `)).toBe(false);
  });

  it('the Check reads the same as the lock screen would', async () => {
    await setSecondaryPassphrase(SECONDARY);

    expect(await checkPassphrase(`${MAIN} `)).toBe('main');
    expect(await checkPassphrase(` ${SECONDARY}`)).toBe('secondary');
    expect(await checkPassphrase(`${WRONG} `)).toBe('none');
  });

  it('a re-key authenticated with a trailing space keeps the passphrase as it was', async () => {
    await rekeyVault(`${MAIN} `);
    lock();

    expect(await unlockWithPassphrase(MAIN)).toBe(true);
  });

  it('changing the passphrase accepts the current one with a trailing space', async () => {
    const derive = vi.spyOn(vaultKdf, 'deriveVaultKek');
    await changePassphrase(`${MAIN} `, 'a brand new passphrase 777', { rekey: false });
    expect(derive.mock.calls.map((c) => c[0])).toContain(MAIN);
    lock();

    expect(await unlockWithPassphrase('a brand new passphrase 777')).toBe(true);
  });

  it('never derives more than two keys for one attempt', async () => {
    lock();
    const derive = vi.spyOn(vaultKdf, 'deriveVaultKek') as unknown as { mock: { calls: Array<[string, string, KdfParams]> } };

    await unlockWithPassphrase(`${WRONG} `);

    expect(derive.mock.calls.map((c) => c[0])).toEqual([`${WRONG} `, WRONG]);
  });
});
