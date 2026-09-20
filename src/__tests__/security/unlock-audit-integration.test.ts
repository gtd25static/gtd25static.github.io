import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, unlockWithRemoteKey,
  configureMaxUnlockAttempts, __resetVaultStateForTests,
} from '../../db/vault';

const PASSPHRASE = 'audit test passphrase';

async function enableAuditLog() {
  await db.localSettings.update('local', { paranoidUnlockLogEnabled: true });
}
async function readLog() {
  return (await db.localSettings.get('local'))?.unlockLog ?? [];
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('unlock audit — vault integration', () => {
  it('logs a passphrase success and a wrong-passphrase failure', async () => {
    await enableParanoid(PASSPHRASE); // enabling counts as the first unlock
    await enableAuditLog();
    lock();

    expect(await unlockWithPassphrase('nope')).toBe(false);
    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);

    const log = await readLog();
    expect(log.map((e) => ({ method: e.method, ok: e.ok }))).toEqual([
      { method: 'passphrase', ok: false },
      { method: 'passphrase', ok: true },
    ]);
  });

  it('writes nothing while the audit toggle is off', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    await unlockWithPassphrase(PASSPHRASE);
    expect(await readLog()).toEqual([]);
  });
});

// The log used to be tamper-evident for the passphrase only: a wrong security key
// or a wrong relayed RUK returned false without logging anything and without
// advancing the tripwire, so an attempt made in your absence left no trace.
describe('unlock audit — the other two unlock methods', () => {
  it('logs a failed remote unlock without ever counting it toward the wipe', async () => {
    await enableAuditLog();
    await enableParanoid(PASSPHRASE);
    await configureMaxUnlockAttempts(3);
    // Enrol a RUK so there is something to fail against.
    const { wrapDekWithRuk } = await import('../../db/vault');
    await wrapDekWithRuk(crypto.getRandomValues(new Uint8Array(32)));
    lock();

    expect(await unlockWithRemoteKey(new Uint8Array(32))).toBe(false); // wrong RUK

    const log = await readLog();
    expect(log.some((e) => e.method === 'remote' && e.ok === false)).toBe(true);
    // Whoever can write the repo drives this path; counting it would be a remote
    // wipe trigger.
    expect((await db.vault.get('vault'))?.failedUnlockAttempts ?? 0).toBe(0);
  });
});
