import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, isUnlocked, checkPassphrase,
  setSecondaryPassphrase, clearSecondaryPassphrase, changePassphrase,
  configureMaxUnlockAttempts, __resetVaultStateForTests,
} from '../../db/vault';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import { getErrorLog, clearErrorLog } from '../../lib/diagnostics';
import type { Task, TaskList, Subtask } from '../../db/models';

// Checking a passphrase from Settings: it must say which slot a passphrase opens
// exactly as the lock screen would, and it must never act on the answer — above
// all, confirming the secondary passphrase must not start its re-key.

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';
const ROTATED = 'a rotated main passphrase 789';
const WRONG = 'not any passphrase 000';

async function seedRealContent() {
  await db.taskLists.add({ id: 'l1', name: 'FIRE_THE_CFO list', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'FIRE_THE_CFO on Monday', description: 'LAYOFF_MEMO_Q3', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'WHISTLEBLOWER contact', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Subtask);
}

/** Everything a check could conceivably touch, read through the unlocked vault. */
async function deviceState() {
  return {
    vault: await db.vault.get('vault'),
    taskLists: await db.taskLists.toArray(),
    tasks: await db.tasks.toArray(),
    subtasks: await db.subtasks.toArray(),
    changeLog: await db.changeLog.count(),
    local: await db.localSettings.get('local'),
  };
}

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
  await seedRealContent();
  await enableParanoid(REAL);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
});

describe('checkPassphrase answers like the lock screen', () => {
  beforeEach(async () => {
    await setSecondaryPassphrase(SECONDARY);
  });

  it("recognises the secondary passphrase", async () => {
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });

  it('recognises the main passphrase', async () => {
    expect(await checkPassphrase(REAL)).toBe('main');
  });

  it('rejects any other passphrase', async () => {
    expect(await checkPassphrase(WRONG)).toBe('none');
    expect(await checkPassphrase('')).toBe('none');
  });

  it('does not trim, because the lock screen does not either', async () => {
    const padded = ` ${SECONDARY} `;
    expect(await checkPassphrase(padded)).toBe('none');
    lock();
    expect(await unlockWithPassphrase(padded)).toBe(false);
  });

  it('follows a change of the main passphrase', async () => {
    await changePassphrase(ROTATED);
    expect(await checkPassphrase(ROTATED)).toBe('main');
    expect(await checkPassphrase(REAL)).toBe('none');
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });

  it('says none once the secondary passphrase is removed', async () => {
    await clearSecondaryPassphrase();
    expect(await checkPassphrase(SECONDARY)).toBe('none');
    expect(await checkPassphrase(REAL)).toBe('main');
  });
});

describe('checkPassphrase reveals nothing without the passphrase', () => {
  it('reads the same for a guess whether or not a secondary passphrase is set', async () => {
    expect(await checkPassphrase(SECONDARY)).toBe('none'); // never set: slot 2 is garbage
    await setSecondaryPassphrase(SECONDARY);
    expect(await checkPassphrase(WRONG)).toBe('none');
  });

  it('writes no unlock-log entry and sends nothing to other tabs', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const tab = listeningTab();
    const logBefore = (await db.localSettings.get('local'))?.unlockLog ?? [];
    try {
      await checkPassphrase(SECONDARY);
      await checkPassphrase(REAL);
      await checkPassphrase(WRONG);
      await new Promise((r) => setTimeout(r, 20));
      expect(tab.heard).toEqual([]);
    } finally {
      tab.close();
    }
    expect((await db.localSettings.get('local'))?.unlockLog ?? []).toEqual(logBefore);
  });
});

describe('checkPassphrase never acts on the answer', () => {
  beforeEach(async () => {
    await setSecondaryPassphrase(SECONDARY);
  });

  it('leaves the device byte-for-byte as it was, for every outcome', async () => {
    const before = await deviceState();
    await checkPassphrase(SECONDARY);
    await checkPassphrase(REAL);
    await checkPassphrase(WRONG);
    expect(await deviceState()).toEqual(before);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('FIRE_THE_CFO on Monday');
  });

  it('does not count wrong checks as failed attempts (no wipe tripwire)', async () => {
    await configureMaxUnlockAttempts(3);
    for (let i = 0; i < 5; i++) expect(await checkPassphrase(`${WRONG} ${i}`)).toBe('none');
    const vault = await db.vault.get('vault');
    expect(vault).toBeDefined();
    expect(vault?.failedUnlockAttempts ?? 0).toBe(0);
    expect((await db.tasks.get('t1'))?.title).toBe('FIRE_THE_CFO on Monday');
  });

  it('leaves the secondary passphrase working: afterwards it still re-keys at the lock screen', async () => {
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    const tasks = await db.tasks.toArray();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).not.toContain('FIRE_THE_CFO');
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(false); // the real one is gone, as designed
  });

  it('leaves the main passphrase working with the real content', async () => {
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
    lock();
    expect(await unlockWithPassphrase(REAL)).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('FIRE_THE_CFO on Monday');
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });
});

describe('checkPassphrase while locked', () => {
  it('refuses, without even deriving a key', async () => {
    lock();
    const spy = vi.spyOn(vaultKdf, 'deriveVaultKek');
    await expect(checkPassphrase(REAL)).rejects.toThrow(/unlock/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to answer when the vault locked during the check', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const realDerive = vaultKdf.deriveVaultKek;
    vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(async (pass: string, salt: string, kdf: KdfParams) => {
      const kek = await realDerive(pass, salt, kdf);
      lock(); // idle lock / hotkey mid-derivation
      return kek;
    });
    await expect(checkPassphrase(SECONDARY)).rejects.toThrow(/unlock/i);
  });
});

describe('checkPassphrase when the key cannot be derived', () => {
  it('fails with a plain message, logged under a neutral label', async () => {
    vi.spyOn(vaultKdf, 'deriveVaultKek').mockRejectedValue(new Error('wasm blocked'));
    await expect(checkPassphrase(SECONDARY)).rejects.toThrow(/could not derive/i);
    const labels = getErrorLog().map((e) => JSON.stringify(e));
    expect(labels.some((l) => l.includes('vault.checkPassphrase'))).toBe(true);
    expect(labels.join(' ')).not.toMatch(/duress|decoy/i);
  });
});
