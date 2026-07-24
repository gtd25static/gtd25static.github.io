import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  cacheEncryptionKey, clearEncryptionKey, hasEncryptionKey, getCachedSalt,
  deriveKey, generateSalt,
} from '../../sync/crypto';
import { ensureEncryptionKey } from '../../sync/sync-engine';

const PW = 'sync password';

beforeEach(async () => {
  await resetDb();
  clearEncryptionKey();
  localStorage.removeItem('gtd25-paranoid');
});
afterEach(() => {
  clearEncryptionKey();
  vi.useRealTimers();
});

describe('sync key self-heal (NO_SYNC_KEY after cache expiry)', () => {
  it('the idle expiry drops the key but the salt survives', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PW, salt);
    vi.useFakeTimers();
    cacheEncryptionKey(key, salt);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1_000);
    expect(hasEncryptionKey()).toBe(false);
    expect(getCachedSalt()).toBe(salt); // public material, kept for re-derivation
  });

  it('re-derives on demand from the stored password + surviving salt', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PW, salt);
    vi.useFakeTimers();
    cacheEncryptionKey(key, salt);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1_000);
    vi.useRealTimers();
    expect(hasEncryptionKey()).toBe(false);

    await db.localSettings.put({ id: 'local', encryptionPassword: PW, syncEnabled: true, syncIntervalMs: 60_000 });
    const ensured = await ensureEncryptionKey();
    expect(ensured).not.toBeNull();
    expect(hasEncryptionKey()).toBe(true); // cached again for the next caller
  });

  it('returns null (no throw, no prompt) when the stored password is missing', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PW, salt);
    vi.useFakeTimers();
    cacheEncryptionKey(key, salt);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1_000);
    vi.useRealTimers();

    await db.localSettings.put({ id: 'local', syncEnabled: true, syncIntervalMs: 60_000 }); // sync password not stored
    expect(await ensureEncryptionKey()).toBeNull();
    expect(hasEncryptionKey()).toBe(false);
  });

  it('returns the cached key untouched when it has not expired', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PW, salt);
    cacheEncryptionKey(key, salt);
    expect(await ensureEncryptionKey()).toBe(key);
  });

  it('returns null before any salt has been seen this page-life', async () => {
    await db.localSettings.put({ id: 'local', encryptionPassword: PW, syncEnabled: true, syncIntervalMs: 60_000 });
    expect(await ensureEncryptionKey()).toBeNull();
  });
});
