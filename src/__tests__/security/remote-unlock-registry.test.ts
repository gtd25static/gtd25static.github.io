import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 }); // publishOwnRegistryEntry/getRegistryMacKey use PBKDF2-600k
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  ensureDeviceIdentity, getPublicIdentity, getMailboxPat, setDeviceName, getDeviceName,
  buildRegistryEntry, isAuthenticEntry, publishRegistryEntry, readAuthenticRegistry,
  publishOwnRegistryEntry, getRegistryMacKey,
  REGISTRY_PATH, unlockReqPath, cmdPath,
} from '../../sync/remote-unlock';
import { generateIdentityKeys, publicIdentityOf } from '../../sync/remote-unlock-crypto';
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
    const pub = await getPublicIdentity();
    expect(pub?.ecdsaPub).toEqual(a.ecdsaPub);
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
