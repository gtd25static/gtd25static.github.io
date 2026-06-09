import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { cacheBlobLocal, getSharedBlobBytes } from '../../sync/shared-blobs';
import { setVaultKeyProvider, clearVaultKeyProvider } from '../../db/vault-middleware';
import { deriveKey, generateSalt } from '../../sync/crypto';

const PLAINTEXT = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  clearVaultKeyProvider();
});

describe('shared blob at-rest cache', () => {
  it('stores PLAINTEXT bytes when Paranoid is off (no DEK)', async () => {
    const blobId = 'blob-plain';
    await cacheBlobLocal(blobId, PLAINTEXT);

    const row = await db.sharedBlobs.get(blobId);
    expect(row).toBeDefined();
    expect(Array.from(row!.data)).toEqual(Array.from(PLAINTEXT));

    // Cache hit returns plaintext without any network.
    const got = await getSharedBlobBytes(blobId);
    expect(Array.from(got)).toEqual(Array.from(PLAINTEXT));
  });

  it('stores DEK-ENCRYPTED bytes when Paranoid is on, and round-trips on read', async () => {
    const dek = await deriveKey('vault-dek', generateSalt());
    setVaultKeyProvider(() => dek);

    const blobId = 'blob-enc';
    await cacheBlobLocal(blobId, PLAINTEXT);

    const row = await db.sharedBlobs.get(blobId);
    expect(row).toBeDefined();
    // At rest it must NOT be the plaintext (IV||ciphertext, longer + different).
    expect(row!.data.length).toBeGreaterThan(PLAINTEXT.length);
    expect(Array.from(row!.data.slice(12, 12 + PLAINTEXT.length))).not.toEqual(Array.from(PLAINTEXT));

    // Reading back (cache hit) decrypts with the active DEK.
    const got = await getSharedBlobBytes(blobId);
    expect(Array.from(got)).toEqual(Array.from(PLAINTEXT));
  });
});
