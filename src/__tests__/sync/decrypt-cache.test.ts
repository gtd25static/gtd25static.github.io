import { vi } from 'vitest';
import { encryptEntity, decryptEntity, clearEncryptionKey } from '../../sync/crypto';

// Reliability review 2026-10-06 (M18): every read in Paranoid Mode decrypted
// every row it returned, and the live queries re-read whole tables on each write
// — ~0.5 s per read at a few thousand tasks on a desktop, several times worse on
// a phone. A row's decrypted content is now remembered by its ciphertext.

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

afterEach(() => {
  vi.restoreAllMocks();
  clearEncryptionKey();
});

it('decrypts the same ciphertext once, and still builds the row from what is stored now', async () => {
  const key = await aesKey();
  const stored = await encryptEntity(key, { id: 't1', listId: 'l1', title: 'Secret', description: 'More', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 }, 'task');
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');

  const first = await decryptEntity(key, stored, 'task');
  const second = await decryptEntity(key, { ...stored, status: 'done', order: 5 }, 'task');

  expect(decrypt).toHaveBeenCalledTimes(1);
  expect(first).toMatchObject({ title: 'Secret', description: 'More', status: 'todo' });
  expect(second).toMatchObject({ title: 'Secret', description: 'More', status: 'done', order: 5 });
  // Each caller gets its own copy.
  (first as { title: string }).title = 'changed by a caller';
  expect((await decryptEntity(key, stored, 'task')).title).toBe('Secret');
});

it('another key never gets what this one decrypted, and locking forgets it all', async () => {
  const key = await aesKey();
  const stored = await encryptEntity(key, { id: 't1', listId: 'l1', title: 'Secret', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 }, 'task');
  await decryptEntity(key, stored, 'task');

  await expect(decryptEntity(await aesKey(), stored, 'task')).rejects.toThrow();

  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  clearEncryptionKey(); // what locking does
  await decryptEntity(key, stored, 'task');
  expect(decrypt).toHaveBeenCalled();
});
