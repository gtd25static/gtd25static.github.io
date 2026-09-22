import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, confirmCurrentPassphrase,
  setSecondaryPassphrase, removeSecurityKey, __resetVaultStateForTests,
} from '../../db/vault';
import { __resetTabChannelForTests } from '../../lib/tab-channel';
import { getErrorLog, clearErrorLog } from '../../lib/diagnostics';
import type { Task } from '../../db/models';

// The gate in front of the actions that change how the vault opens: it must
// accept exactly the main passphrase and act on nothing.

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';
const WRONG = 'not any passphrase 000';

async function deviceState() {
  return {
    vault: await db.vault.get('vault'),
    tasks: await db.tasks.toArray(),
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
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'FIRE_THE_CFO on Monday', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await enableParanoid(REAL);
  await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  __resetTabChannelForTests();
  localStorage.clear();
});

describe('confirmCurrentPassphrase', () => {
  it('accepts the main passphrase only', async () => {
    await setSecondaryPassphrase(SECONDARY);
    expect(await confirmCurrentPassphrase(REAL)).toBe(true);
    expect(await confirmCurrentPassphrase(SECONDARY)).toBe(false);
    expect(await confirmCurrentPassphrase(WRONG)).toBe(false);
    expect(await confirmCurrentPassphrase('')).toBe(false);
  });

  it('does not trim, because the lock screen does not either', async () => {
    expect(await confirmCurrentPassphrase(` ${REAL} `)).toBe(false);
  });

  it('changes nothing, counts nothing, logs nothing, signals nothing', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const before = await deviceState();
    const tab = listeningTab();
    try {
      await confirmCurrentPassphrase(REAL);
      await confirmCurrentPassphrase(SECONDARY);
      await confirmCurrentPassphrase(WRONG);
      await new Promise((r) => setTimeout(r, 20));
      expect(await deviceState()).toEqual(before);
      expect(tab.heard).toEqual([]);
      expect(getErrorLog()).toEqual([]);
    } finally {
      tab.close();
    }
  });

  it('refuses while locked, without even deriving a key', async () => {
    lock();
    const spy = vi.spyOn(vaultKdf, 'deriveVaultKek');
    await expect(confirmCurrentPassphrase(REAL)).rejects.toThrow(/unlock/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to answer when the vault locked during the check', async () => {
    const realDerive = vaultKdf.deriveVaultKek;
    vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(async (pass: string, salt: string, kdf: KdfParams) => {
      const kek = await realDerive(pass, salt, kdf);
      lock();
      return kek;
    });
    await expect(confirmCurrentPassphrase(REAL)).rejects.toThrow(/unlock/i);
  });

  it('fails plainly when the key cannot be derived, logged under a neutral label', async () => {
    vi.spyOn(vaultKdf, 'deriveVaultKek').mockRejectedValue(new Error('wasm blocked'));
    await expect(confirmCurrentPassphrase(REAL)).rejects.toThrow(/could not derive/i);
    const labels = getErrorLog().map((e) => JSON.stringify(e)).join(' ');
    expect(labels).toContain('vault.confirmPassphrase');
    expect(labels).not.toMatch(/duress|decoy/i);
  });

  it('still answers after a lock/unlock cycle', async () => {
    lock();
    await unlockWithPassphrase(REAL);
    expect(await confirmCurrentPassphrase(REAL)).toBe(true);
  });
});

describe('removeSecurityKey', () => {
  it('requires the vault to be unlocked', async () => {
    lock();
    await expect(removeSecurityKey()).rejects.toThrow(/Unlock the vault/);
  });
});
