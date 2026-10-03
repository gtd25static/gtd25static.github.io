import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import {
  enableParanoid, lock, unlockWithPassphrase, setSecondaryPassphrase, __resetVaultStateForTests,
} from '../../db/vault';
import { cacheBlobLocal, getSharedBlobBytes } from '../../sync/shared-blobs';
import { ensureDeviceId, clearDeviceIdCache } from '../../sync/change-log';
import { placeholderBlobBytes } from '../../lib/placeholder-content';

// After a secondary-passphrase unlock the device must behave like any other
// Paranoid device. Two places did not (threat-model review, 2026-10-03):
//  - the shared-file cache was rewritten with PLAINTEXT placeholder bytes, which
//    every read then tried to decrypt — files failed to open, and plaintext in a
//    Paranoid cache could only come from this swap (a mark on disk);
//  - this tab kept stamping its changes with the device id the swap had just
//    replaced (a module-level cache), linking it to the real repository.

const REAL = 'consistency real passphrase 3 river';
const SECONDARY = 'consistency other passphrase 8 stone';

async function rawBlob(id: string): Promise<Uint8Array | undefined> {
  setMigrationBypass(true);
  try {
    return (await db.sharedBlobs.get(id))?.data;
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  clearDeviceIdCache();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('after a secondary-passphrase unlock', () => {
  it('cached shared files still open, and are encrypted on disk like any other', async () => {
    await enableParanoid(REAL);
    await cacheBlobLocal('b1', new TextEncoder().encode('real file bytes'));
    await setSecondaryPassphrase(SECONDARY);
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);

    expect(await getSharedBlobBytes('b1')).toEqual(placeholderBlobBytes('b1'));
    const raw = await rawBlob('b1');
    expect(raw).toBeDefined();
    expect(Buffer.from(raw!).equals(Buffer.from(placeholderBlobBytes('b1')))).toBe(false);
  });

  it('new changes carry the new device id', async () => {
    await enableParanoid(REAL);
    const before = await ensureDeviceId(); // cached by this tab, as in real use
    await setSecondaryPassphrase(SECONDARY);
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);

    const stored = (await db.localSettings.get('local'))?.deviceId;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(before);
    expect(await ensureDeviceId()).toBe(stored);
  });
});

describe('a cached shared file that will not decrypt', () => {
  it('is treated as a cache miss and dropped, not an error that sticks', async () => {
    await enableParanoid(REAL);
    setMigrationBypass(true);
    try {
      await db.sharedBlobs.put({ id: 'b2', data: new TextEncoder().encode('not ciphertext'), cachedAt: 1 });
    } finally {
      setMigrationBypass(false);
    }
    // No sync configured: a miss falls through to the download, which says so.
    await expect(getSharedBlobBytes('b2')).rejects.toThrow('Sync is not configured');
    expect(await rawBlob('b2')).toBeUndefined();
  });
});
