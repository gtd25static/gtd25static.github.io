import { vi } from 'vitest';

vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);

import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';
import { fakeRepo } from '../helpers/fake-repo';
import { deriveKey, generateSalt, cacheEncryptionKey, encryptBytes, decryptBytes } from '../../sync/crypto';
import {
  paddedLength, sealSharedBlob, decryptSharedBlob, blobAad, uploadSharedBlob, blobPath, BLOB_BRANCH,
  sharedBlobDownloadTimeoutMs,
} from '../../sync/shared-blobs';

// A file's exact size, readable off its upload by anyone inspecting the traffic,
// says a lot about which file it is. Shared files now travel padded to a Padmé
// length (≤ 4 KiB all alike, at most ~6% larger above that), framed with their
// real length inside the ciphertext.

let key: CryptoKey;
const bytes = (n: number) => new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);

beforeAll(async () => {
  key = await deriveKey('sync password', generateSalt());
});

describe('paddedLength', () => {
  it('rounds everything up to 4 KiB to the same size, and grows in Padmé steps above it', () => {
    expect(paddedLength(0)).toBe(4096);
    expect(paddedLength(1)).toBe(4096);
    expect(paddedLength(4092)).toBe(4096); // 4-byte length prefix included
    expect(paddedLength(4093)).toBe(4352);
    expect(paddedLength(1_000_000)).toBe(1_015_808);
    expect(paddedLength(30 * 1024 * 1024)).toBe(31_981_568);
  });

  it('never shrinks, never goes below the content, and adds at most 6.25% above the floor', () => {
    let previous = 0;
    for (let n = 0; n < 3_000_000; n += 997) {
      const padded = paddedLength(n);
      expect(padded).toBeGreaterThanOrEqual(n + 4);
      expect(padded).toBeGreaterThanOrEqual(previous);
      if (n >= 4096) expect(padded / (n + 4)).toBeLessThanOrEqual(1.0625);
      previous = padded;
    }
  });
});

describe('sealSharedBlob / decryptSharedBlob', () => {
  it.each([0, 1, 4092, 4093, 1_000_000])('round-trips %i bytes', async (n) => {
    const plain = bytes(n);
    const sealed = await sealSharedBlob(key, plain, 'id1');
    expect(sealed.length).toBe(paddedLength(n) + 28);
    const opened = await decryptSharedBlob(key, sealed, 'id1');
    // Byte loop, not toEqual: a deep compare of a megabyte crawls under load.
    expect(opened.length).toBe(n);
    expect(opened.every((b, i) => b === plain[i])).toBe(true);
  });

  it('still opens files written before padding (bound, and before that unbound)', async () => {
    const plain = bytes(100);
    expect(await decryptSharedBlob(key, await encryptBytes(key, plain, blobAad('id1')), 'id1')).toEqual(plain);
    expect(await decryptSharedBlob(key, await encryptBytes(key, plain), 'id1')).toEqual(plain);
  });

  it('does not open as an unpadded file, so an older version fails cleanly instead of showing padding', async () => {
    const sealed = await sealSharedBlob(key, bytes(100), 'id1');
    await expect(decryptBytes(key, sealed, blobAad('id1'))).rejects.toBeTruthy();
    await expect(decryptBytes(key, sealed)).rejects.toBeTruthy();
  });

  it('stays bound to its id', async () => {
    const sealed = await sealSharedBlob(key, bytes(100), 'id1');
    await expect(decryptSharedBlob(key, sealed, 'id2')).rejects.toBeTruthy();
  });

  it('rejects a frame whose length runs past its end', async () => {
    const framed = new Uint8Array(4096);
    new DataView(framed.buffer).setUint32(0, 5000);
    const forged = await encryptBytes(key, framed, new TextEncoder().encode('sharedBlob:v2:id1'));
    await expect(decryptSharedBlob(key, forged, 'id1')).rejects.toThrow();
  });
});

describe('uploads', () => {
  beforeEach(async () => {
    await resetSyncState();
    fakeRepo.reset();
    await setupSyncCredentials();
    const salt = generateSalt();
    cacheEncryptionKey(key, salt);
  });

  it('a 10-byte snippet and a 3000-byte file look the same on the wire', async () => {
    await uploadSharedBlob('small', bytes(10));
    await uploadSharedBlob('larger', bytes(3000));
    const small = fakeRepo.readBytes(blobPath('small'), BLOB_BRANCH)!;
    const larger = fakeRepo.readBytes(blobPath('larger'), BLOB_BRANCH)!;
    expect(small.length).toBe(4096 + 28);
    expect(larger.length).toBe(small.length);
  });
});

describe('download time budget', () => {
  it('follows the item size, and the folder cap when it is not known', () => {
    expect(sharedBlobDownloadTimeoutMs(100)).toBe(15_000);
    expect(sharedBlobDownloadTimeoutMs(10_000_000)).toBeGreaterThan(50_000);
    expect(sharedBlobDownloadTimeoutMs()).toBeGreaterThan(sharedBlobDownloadTimeoutMs(10_000_000));
  });
});
