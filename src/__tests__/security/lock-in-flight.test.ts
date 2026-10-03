import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, __resetVaultStateForTests } from '../../db/vault';
import { cacheEncryptionKey, hasEncryptionKey, clearEncryptionKey } from '../../sync/crypto';

// Locking forgets the sync key, but a derivation already running when the lock
// landed (PBKDF2-600k, ~1 s) used to finish afterwards and put the key back —
// into a locked tab, with a fresh 30-minute timer (threat-model review).

const PASS = 'in flight passphrase 5 meadow';

async function aKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  clearEncryptionKey();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  clearEncryptionKey();
  localStorage.removeItem('gtd25-paranoid');
});

describe('the sync key cache on a locked Paranoid device', () => {
  it('refuses a key that arrives after the lock', async () => {
    await enableParanoid(PASS);
    lock();
    cacheEncryptionKey(await aKey(), 'salt');
    expect(hasEncryptionKey()).toBe(false);
  });

  it('takes it while unlocked', async () => {
    await enableParanoid(PASS);
    cacheEncryptionKey(await aKey(), 'salt');
    expect(hasEncryptionKey()).toBe(true);
  });

  it('takes it on a device without Paranoid Mode', async () => {
    cacheEncryptionKey(await aKey(), 'salt');
    expect(hasEncryptionKey()).toBe(true);
  });
});
