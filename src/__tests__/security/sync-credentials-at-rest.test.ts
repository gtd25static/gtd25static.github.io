import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, getVaultSecrets, __resetVaultStateForTests } from '../../db/vault';
import { rememberSyncPassword, getSyncPat } from '../../sync/sync-credentials';

// The sync password prompt (EncryptionPasswordModal) wrote the password straight
// into localSettings — plaintext on disk even on a Paranoid device, where every
// sync secret is supposed to live only inside the encrypted vault — and looked for
// the PAT there too, where a Paranoid device never keeps it.

const PASS = 'sync credentials passphrase 7 lantern';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('sync credentials on a Paranoid device', () => {
  it('a remembered sync password goes into the vault, never into plaintext settings', async () => {
    await enableParanoid(PASS);

    await rememberSyncPassword('a sync password 123!');
    expect(getVaultSecrets()?.syncPassword).toBe('a sync password 123!');
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBeUndefined();
  });

  it('the PAT is read from the vault', async () => {
    await db.localSettings.update('local', { githubPat: 'ghp_real_token' });
    await enableParanoid(PASS);

    expect((await db.localSettings.get('local'))?.githubPat).toBeUndefined();
    expect(await getSyncPat()).toBe('ghp_real_token');
  });
});

describe('sync credentials without Paranoid Mode', () => {
  it('stay in local settings, as before', async () => {
    await db.localSettings.update('local', { githubPat: 'ghp_plain' });

    await rememberSyncPassword('a sync password 123!');
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe('a sync password 123!');
    expect(await getSyncPat()).toBe('ghp_plain');
  });
});
