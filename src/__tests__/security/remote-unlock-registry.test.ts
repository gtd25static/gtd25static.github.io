import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 }); // publishOwnRegistryEntry/getRegistryMacKey use PBKDF2-600k
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  ensureDeviceIdentity, getMailboxPat, setDeviceName, getDeviceName,
  buildRegistryEntry, isAuthenticEntry, publishRegistryEntry, readAuthenticRegistry,
  publishOwnRegistryEntry, getRegistryMacKey, isSealedEntry, sealLegacyRegistryEntries, maybeSealRegistry,
  refreshManagedDeviceWipeStatuses, listEnrolledApprovers,
  REGISTRY_PATH, unlockReqPath, cmdPath,
} from '../../sync/remote-unlock';
import { generateIdentityKeys, publicIdentityOf, registryMac, registryEntryBytes, verifyRegistryMac } from '../../sync/remote-unlock-crypto';
import { squashDefaultBranch } from '../../sync/history-compaction';
import { getFile } from '../../sync/github-api';
import { cacheEncryptionKey, clearEncryptionKey, generateSalt } from '../../sync/crypto';

// Mock the GitHub transport so registry publish/read hit an in-memory file.
let files: Record<string, { data: string; sha: string }> = {};
vi.mock('../../sync/github-api', () => ({
  getFile: vi.fn((_pat: string, _repo: string, path: string) =>
    Promise.resolve(files[path] ? { ...files[path] } : null)),
  putFile: vi.fn((_pat: string, _repo: string, path: string, content: string) => {
    files[path] = { data: content, sha: `sha-${Date.now()}-${Math.random()}` };
    return Promise.resolve(files[path].sha);
  }),
}));

vi.mock('../../sync/history-compaction', () => ({ squashDefaultBranch: vi.fn(() => Promise.resolve(true)) }));

// A fast HMAC key stands in for the (slow PBKDF2) syncPassword-derived registry key.
async function fakeMacKey(seed = 1): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

beforeEach(async () => {
  files = {};
  await resetDb();
  clearEncryptionKey();
  localStorage.removeItem('gtd25-paranoid');
});
afterEach(() => { vi.clearAllMocks(); clearEncryptionKey(); });

describe('remote-unlock: device identity', () => {
  it('generates and persists identity once, then returns the same keys', async () => {
    const a = await ensureDeviceIdentity();
    const b = await ensureDeviceIdentity();
    expect(a.ecdhPub.x).toBe(b.ecdhPub.x);
    expect((await db.localSettings.get('local'))?.deviceIdentity?.ecdsaPub).toEqual(a.ecdsaPub);
    expect((await db.localSettings.get('local'))?.deviceIdentity?.ecdhPriv?.d).toBeTruthy();
  });

  it('device name defaults then persists a custom value', async () => {
    expect(await getDeviceName()).toBeTruthy();
    await setDeviceName('Work Laptop');
    expect(await getDeviceName()).toBe('Work Laptop');
  });

  it('getMailboxPat reflects the plaintext PAT in localSettings', async () => {
    expect(await getMailboxPat()).toBeNull();
    await db.localSettings.update('local', { githubPat: 'ghp_xyz' });
    expect(await getMailboxPat()).toBe('ghp_xyz');
  });

  it('builds distinct per-device mailbox paths', () => {
    expect(unlockReqPath('dev-1')).toBe('gtd25-unlock-req-dev-1.json');
    expect(cmdPath('dev-1')).toBe('gtd25-cmd-dev-1.json');
    expect(REGISTRY_PATH).toBe('gtd25-devices.json');
  });
});

describe('remote-unlock: MAC-authenticated registry', () => {
  it('publishes an authentic entry and reads it back; merges multiple devices', async () => {
    const mac = await fakeMacKey();
    const idA = await generateIdentityKeys();
    const idB = await generateIdentityKeys();
    const eA = await buildRegistryEntry('dev-A', 'Laptop', publicIdentityOf(idA), true, mac);
    const eB = await buildRegistryEntry('dev-B', 'Phone', publicIdentityOf(idB), false, mac);

    await publishRegistryEntry('pat', 'me/repo', eA);
    await publishRegistryEntry('pat', 'me/repo', eB);
    expect(files[REGISTRY_PATH]).toBeTruthy();

    const authentic = await readAuthenticRegistry('pat', 'me/repo', mac);
    expect(authentic.map((e) => e.deviceId).sort()).toEqual(['dev-A', 'dev-B']);
    expect(authentic.find((e) => e.deviceId === 'dev-B')?.paranoid).toBe(false);
  });

  it('rejects an entry forged by a PAT-only attacker (wrong/missing MAC key)', async () => {
    const real = await fakeMacKey(1);
    const attacker = await fakeMacKey(2); // lacks the syncPassword -> different key
    const id = await generateIdentityKeys();
    const entry = await buildRegistryEntry('dev-A', 'Laptop', publicIdentityOf(id), false, real);

    // Authentic under the real key, not under the attacker's.
    expect(await isAuthenticEntry(entry, real)).toBe(true);
    expect(await isAuthenticEntry(entry, attacker)).toBe(false);

    // A reader using the real key drops an entry whose MAC doesn't verify.
    files[REGISTRY_PATH] = { data: JSON.stringify({ 'dev-A': { ...entry, mac: 'forged' } }), sha: 's' };
    expect(await readAuthenticRegistry('pat', 'me/repo', real)).toEqual([]);
  });

  it('rejects an entry whose public key was substituted after MAC', async () => {
    const mac = await fakeMacKey();
    const id = await generateIdentityKeys();
    const evil = await generateIdentityKeys();
    const entry = await buildRegistryEntry('dev-A', 'Laptop', publicIdentityOf(id), false, mac);
    const tampered = { ...entry, ecdhPub: evil.ecdhPub }; // swap key, keep old MAC
    expect(await isAuthenticEntry(tampered, mac)).toBe(false);
  });

  it('publishOwnRegistryEntry advertises a non-Paranoid device, discoverable under the same syncPassword', async () => {
    // Cache a sync salt (any AES key works — only the salt is used for the MAC KDF).
    const salt = generateSalt();
    const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    cacheEncryptionKey(aes, salt);
    await db.localSettings.update('local', { deviceId: 'phone-x', githubRepo: 'me/repo', githubPat: 'pat', encryptionPassword: 'team-sync-pw' });

    expect(await publishOwnRegistryEntry()).toBe(true);

    // Another device that knows the SAME syncPassword derives the matching MAC key
    // and sees the entry as authentic and non-paranoid.
    const macKey = await getRegistryMacKey();
    expect(macKey).not.toBeNull();
    const reg = await readAuthenticRegistry('pat', 'me/repo', macKey!);
    const me = reg.find((e) => e.deviceId === 'phone-x');
    expect(me?.paranoid).toBe(false);

    // A reader without the syncPassword (different key) cannot authenticate it.
    const wrong = await fakeMacKey(123);
    expect(await readAuthenticRegistry('pat', 'me/repo', wrong)).toEqual([]);
  });

  it('publishOwnRegistryEntry is a no-op until sync salt is available', async () => {
    await db.localSettings.update('local', { deviceId: 'd', githubRepo: 'r', githubPat: 'p', encryptionPassword: 'pw' });
    expect(await publishOwnRegistryEntry()).toBe(false); // no cached salt yet
  });
});

describe('remote-unlock: registry names and Paranoid flags travel sealed', () => {
  // The MAC formula every build (old and new) verifies with.
  async function legacyEntry(deviceId: string, name: string, paranoid: boolean, mac: CryptoKey, updatedAt = 1_000) {
    const id = await generateIdentityKeys();
    const base = { deviceId, name, ecdhPub: id.ecdhPub, ecdsaPub: id.ecdsaPub, paranoid, updatedAt };
    return { ...base, mac: await registryMac(mac, registryEntryBytes(base)) };
  }

  it('publishes neither the name nor the Paranoid flag in the clear; a key holder reads both', async () => {
    const mac = await fakeMacKey();
    const entry = await buildRegistryEntry('dev-A', 'Pixel de Martín', publicIdentityOf(await generateIdentityKeys()), true, mac);
    await publishRegistryEntry('pat', 'me/repo', entry);

    const wire = files[REGISTRY_PATH].data;
    expect(wire).not.toContain('Pixel');
    expect(wire).not.toContain('Mart');
    const onWire = JSON.parse(wire)['dev-A'];
    expect(onWire.paranoid).toBe(false); // every entry says false on the wire
    expect(isSealedEntry(onWire)).toBe(true);

    const [read] = await readAuthenticRegistry('pat', 'me/repo', mac);
    expect(read.name).toBe('Pixel de Martín');
    expect(read.paranoid).toBe(true);
  });

  it('a build from before sealing still verifies a sealed entry (same MAC formula over the wire values)', async () => {
    const mac = await fakeMacKey();
    const e = await buildRegistryEntry('dev-A', 'Laptop', publicIdentityOf(await generateIdentityKeys()), true, mac);
    expect(await verifyRegistryMac(mac, e.mac, registryEntryBytes(e))).toBe(true);
  });

  it('the sealed length does not tell a short name from a long one', async () => {
    const mac = await fakeMacKey();
    const pub = publicIdentityOf(await generateIdentityKeys());
    const short = await buildRegistryEntry('dev-A', 'PC', pub, false, mac);
    const long = await buildRegistryEntry('dev-A', 'Portátil del trabajo, planta 3', pub, true, mac);
    expect(short.name.length).toBe(long.name.length);
  });

  it('still reads an entry written before sealing', async () => {
    const mac = await fakeMacKey();
    files[REGISTRY_PATH] = { data: JSON.stringify({ 'dev-L': await legacyEntry('dev-L', 'Old Phone', true, mac) }), sha: 's' };
    const [read] = await readAuthenticRegistry('pat', 'me/repo', mac);
    expect(read).toMatchObject({ deviceId: 'dev-L', name: 'Old Phone', paranoid: true });
  });

  it('drops a sealed entry that does not open, even with a valid MAC; and a tampered seal fails the MAC', async () => {
    const mac = await fakeMacKey();
    const junk = await legacyEntry('dev-J', 'sealed:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAA', false, mac);
    const good = await buildRegistryEntry('dev-G', 'Good', publicIdentityOf(await generateIdentityKeys()), false, mac);
    const tampered = { ...good, deviceId: 'dev-T', name: good.name.slice(0, -4) + 'AAAA' };
    files[REGISTRY_PATH] = { data: JSON.stringify({ 'dev-J': junk, 'dev-G': good, 'dev-T': tampered }), sha: 's' };
    expect((await readAuthenticRegistry('pat', 'me/repo', mac)).map((e) => e.deviceId)).toEqual(['dev-G']);
  });

  it("a seal moved into another device's entry does not open there (bound to the deviceId)", async () => {
    const mac = await fakeMacKey();
    const a = await buildRegistryEntry('dev-A', 'Phone', publicIdentityOf(await generateIdentityKeys()), false, mac);
    // Even a key holder re-MACing the moved seal gets an entry that does not open.
    const moved = await legacyEntry('dev-B', a.name, false, mac);
    files[REGISTRY_PATH] = { data: JSON.stringify({ 'dev-B': moved }), sha: 's' };
    expect(await readAuthenticRegistry('pat', 'me/repo', mac)).toEqual([]);
  });

  it('sealLegacyRegistryEntries seals plaintext entries in place, keeps their time, and leaves the rest alone', async () => {
    const mac = await fakeMacKey();
    const legacy = await legacyEntry('dev-L', 'Old Phone', true, mac, 4242);
    const sealed = await buildRegistryEntry('dev-S', 'New', publicIdentityOf(await generateIdentityKeys()), false, mac);
    const forged = { ...(await legacyEntry('dev-F', 'Evil', false, await fakeMacKey(9))) };
    const tomb = { deviceId: 'dev-X', removed: true, removedAt: 5, mac: 'kept-as-is' };
    files[REGISTRY_PATH] = { data: JSON.stringify({ 'dev-L': legacy, 'dev-S': sealed, 'dev-F': forged, 'dev-X': tomb }), sha: 's' };

    expect(await sealLegacyRegistryEntries('pat', 'me/repo', mac)).toBe(true);
    const reg = JSON.parse(files[REGISTRY_PATH].data);
    expect(files[REGISTRY_PATH].data).not.toContain('Old Phone');
    expect(isSealedEntry(reg['dev-L'])).toBe(true);
    expect(reg['dev-L'].updatedAt).toBe(4242); // "last seen" is not refreshed by sealing
    expect(reg['dev-S']).toEqual(sealed);
    expect(reg['dev-F']).toEqual(forged); // not ours to rewrite: still counts for nothing
    expect(reg['dev-X']).toEqual(tomb);
    const read = await readAuthenticRegistry('pat', 'me/repo', mac);
    expect(read.find((e) => e.deviceId === 'dev-L')).toMatchObject({ name: 'Old Phone', paranoid: true, updatedAt: 4242 });

    // Nothing left to seal: no write.
    const before = files[REGISTRY_PATH].sha;
    expect(await sealLegacyRegistryEntries('pat', 'me/repo', mac)).toBe(false);
    expect(files[REGISTRY_PATH].sha).toBe(before);
  });
});

describe('remote-unlock: maybeSealRegistry (once per device, after a sync)', () => {
  async function setUpSync() {
    const salt = generateSalt();
    cacheEncryptionKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']), salt);
    await db.localSettings.update('local', { deviceId: 'me', githubRepo: 'me/repo', githubPat: 'pat', encryptionPassword: 'team-sync-pw' });
    await db.syncMeta.put({ id: 'sync-meta' } as never);
    await ensureDeviceIdentity(); // takes part in the registry
  }

  it('a device that never took part in the registry does not touch the network for it', async () => {
    await db.localSettings.update('local', { deviceId: 'me', githubRepo: 'me/repo', githubPat: 'pat', encryptionPassword: 'pw' });
    await db.syncMeta.put({ id: 'sync-meta' } as never);
    files[REGISTRY_PATH] = { data: '{}', sha: 's' };
    await maybeSealRegistry('pat', 'me/repo');
    expect(getFile).not.toHaveBeenCalled();
    expect(squashDefaultBranch).not.toHaveBeenCalled();
  });

  it('seals the legacy entries, squashes the history once, and does nothing on later syncs', async () => {
    await setUpSync();
    const key = (await getRegistryMacKey())!;
    const id = await generateIdentityKeys();
    const base = { deviceId: 'old', name: 'Old Phone', ecdhPub: id.ecdhPub, ecdsaPub: id.ecdsaPub, paranoid: true, updatedAt: 7 };
    files[REGISTRY_PATH] = { data: JSON.stringify({ old: { ...base, mac: await registryMac(key, registryEntryBytes(base)) } }), sha: 's' };

    await maybeSealRegistry('pat', 'me/repo');
    expect(files[REGISTRY_PATH].data).not.toContain('Old Phone');
    expect(squashDefaultBranch).toHaveBeenCalledTimes(1);
    expect((await db.syncMeta.get('sync-meta'))?.registrySealedAt).toBeGreaterThan(0);

    await maybeSealRegistry('pat', 'me/repo');
    expect(squashDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('squashes even when another device already sealed everything (names an older build wrote since)', async () => {
    await setUpSync();
    const key = (await getRegistryMacKey())!;
    const sealed = await buildRegistryEntry('x', 'X', publicIdentityOf(await generateIdentityKeys()), false, key);
    files[REGISTRY_PATH] = { data: JSON.stringify({ x: sealed }), sha: 's' };
    await maybeSealRegistry('pat', 'me/repo');
    expect(squashDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('no registry: marks itself done without a squash', async () => {
    await setUpSync();
    await maybeSealRegistry('pat', 'me/repo');
    expect(squashDefaultBranch).not.toHaveBeenCalled();
    expect((await db.syncMeta.get('sync-meta'))?.registrySealedAt).toBeGreaterThan(0);
  });

  it('without the sync password (no key) it waits for a later sync', async () => {
    await db.localSettings.update('local', { deviceId: 'me', githubRepo: 'me/repo', githubPat: 'pat' });
    await db.syncMeta.put({ id: 'sync-meta' } as never);
    await ensureDeviceIdentity();
    files[REGISTRY_PATH] = { data: '{}', sha: 's' };
    await maybeSealRegistry('pat', 'me/repo');
    expect(squashDefaultBranch).not.toHaveBeenCalled();
    expect((await db.syncMeta.get('sync-meta'))?.registrySealedAt).toBeUndefined();
  });

  it('a refused squash still marks it done (the monthly squash retries), and the error surfaces', async () => {
    await setUpSync();
    files[REGISTRY_PATH] = { data: '{}', sha: 's' };
    vi.mocked(squashDefaultBranch).mockRejectedValueOnce(new Error('force push refused'));
    await expect(maybeSealRegistry('pat', 'me/repo')).rejects.toThrow('force push refused');
    expect((await db.syncMeta.get('sync-meta'))?.registrySealedAt).toBeGreaterThan(0);
  });
});

describe('remote-unlock: names stored as sealed blobs by an older build', () => {
  it("an approver's status refresh replaces a stored sealed blob with the real name, and renames nothing else", async () => {
    const mac = await fakeMacKey();
    const prot = await buildRegistryEntry('prot', 'Work Laptop', publicIdentityOf(await generateIdentityKeys()), true, mac);
    const other = await buildRegistryEntry('other', 'Renamed Since', publicIdentityOf(await generateIdentityKeys()), true, mac);
    files[REGISTRY_PATH] = { data: JSON.stringify({ prot, other }), sha: 's' };
    await db.localSettings.update('local', {
      deviceId: 'phone',
      remoteApproverFor: {
        prot: { ruk: 'r', ecdsaPub: prot.ecdsaPub, name: prot.name, acceptedTs: 1 },
        other: { ruk: 'r', ecdsaPub: other.ecdsaPub, name: 'Old Name', acceptedTs: 1 },
      },
    } as never);

    await refreshManagedDeviceWipeStatuses('pat', 'me/repo', mac);
    const stored = (await db.localSettings.get('local'))?.remoteApproverFor ?? {};
    expect(stored.prot?.name).toBe('Work Laptop');
    expect(stored.other?.name).toBe('Old Name');
  });

  it('a protected device does not show an approver name stored as a sealed blob', async () => {
    await db.vault.put({ id: 'vault', remoteUnlock: { approvers: [
      { deviceId: 'a', name: 'sealed:v1:QUJD', ecdhPub: {}, ecdsaPub: {} },
      { deviceId: 'b', name: 'Phone', ecdhPub: {}, ecdsaPub: {} },
    ] } } as never);
    expect(await listEnrolledApprovers()).toEqual([{ deviceId: 'a', name: 'Unnamed device' }, { deviceId: 'b', name: 'Phone' }]);
  });
});
