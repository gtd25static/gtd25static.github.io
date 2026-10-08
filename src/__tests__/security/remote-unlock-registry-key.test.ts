// The registry key derives from the sync password with PBKDF2-600k (~1-2 s on a
// phone). The approver derived it on every 12 s poll, invitations or not
// (reliability review 2026-10-08). Now: only when there is an invitation to
// check, and a device NOT in Paranoid Mode keeps the last one derived.
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';

const h = vi.hoisted(() => ({
  derive: vi.fn(async (..._a: unknown[]) =>
    crypto.subtle.importKey('raw', new Uint8Array(32).fill(3), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])),
  inbox: null as { data: string; sha: string } | null,
  paranoid: false,
}));

vi.mock('../../sync/remote-unlock-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/remote-unlock-crypto')>()),
  deriveRegistryMacKey: h.derive,
}));
vi.mock('../../sync/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/crypto')>()),
  getCachedSalt: () => 'c2FsdC1mb3ItdGVzdHM=',
}));
vi.mock('../../sync/github-api', () => ({
  getFile: vi.fn(async (_p: string, _r: string, path: string) => (path.startsWith('gtd25-approver-') ? h.inbox : null)),
  putFile: vi.fn(async () => 'sha'),
  deleteFile: vi.fn(async () => undefined),
  getFileConditional: vi.fn(async () => ({ status: 'absent' })),
}));
vi.mock('../../db/paranoid-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/paranoid-flag')>()),
  isParanoidFlagSet: () => h.paranoid,
}));

import { pollApproverInbox, getRegistryMacKey } from '../../sync/remote-unlock';

beforeEach(async () => {
  await resetDb();
  await db.localSettings.update('local', { encryptionPassword: 'sync password one' });
  h.derive.mockClear();
  h.inbox = null;
  h.paranoid = false;
});

it('an empty inbox costs no key derivation', async () => {
  expect(await pollApproverInbox('pat', 'me/repo', 'phone-1')).toBe(0);
  h.inbox = { data: '{}', sha: 's1' };
  expect(await pollApproverInbox('pat', 'me/repo', 'phone-1')).toBe(0);
  expect(h.derive).not.toHaveBeenCalled();
});

it('an invitation to check derives the key', async () => {
  h.inbox = { data: JSON.stringify({ lap: { fromDeviceId: 'lap', ts: 1, rukEcies: {}, sig: 'x' } }), sha: 's1' };
  await pollApproverInbox('pat', 'me/repo', 'phone-1');
  expect(h.derive).toHaveBeenCalled();
});

it('outside Paranoid Mode the key is derived once per password and salt', async () => {
  await db.localSettings.update('local', { encryptionPassword: 'sync password cached' }); // nothing derived for it yet
  const first = await getRegistryMacKey();
  expect(await getRegistryMacKey()).toBe(first);
  expect(h.derive).toHaveBeenCalledTimes(1);

  await db.localSettings.update('local', { encryptionPassword: 'sync password two' });
  await getRegistryMacKey();
  expect(h.derive).toHaveBeenCalledTimes(2);
});

it('a failed derivation is not kept', async () => {
  await db.localSettings.update('local', { encryptionPassword: 'sync password three' });
  h.derive.mockRejectedValueOnce(new Error('derive failed'));
  await expect(getRegistryMacKey()).rejects.toThrow('derive failed');
  await expect(getRegistryMacKey()).resolves.toBeTruthy();
});

it('in Paranoid Mode nothing is kept (no key from the password outlives a lock)', async () => {
  h.paranoid = true;
  await db.localSettings.update('local', { encryptionPassword: 'sync password four' });
  await getRegistryMacKey();
  await getRegistryMacKey();
  expect(h.derive).toHaveBeenCalledTimes(2);
});
