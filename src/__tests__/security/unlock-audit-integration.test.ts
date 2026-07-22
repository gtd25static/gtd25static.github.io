import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, __resetVaultStateForTests,
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
