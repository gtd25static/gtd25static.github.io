import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });

import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import * as vault from '../../db/vault';
import * as ru from '../../sync/remote-unlock';
import { generateIdentityKeys, publicIdentityOf, signPayload } from '../../sync/remote-unlock-crypto';
import type { LocalSettings } from '../../db/models';

// In-memory GitHub mailbox.
let files: Record<string, { data: string; sha: string }> = {};
vi.mock('../../sync/github-api', () => ({
  getFile: vi.fn((_p: string, _r: string, path: string) => Promise.resolve(files[path] ? { ...files[path] } : null)),
  putFile: vi.fn((_p: string, _r: string, path: string, content: string) => {
    files[path] = { data: content, sha: `sha-${Math.random()}` };
    return Promise.resolve(files[path].sha);
  }),
  deleteFile: vi.fn((_p: string, _r: string, path: string) => { delete files[path]; return Promise.resolve(); }),
  getFileConditional: vi.fn((_p: string, _r: string, path: string, etag?: string | null) => {
    const f = files[path];
    if (!f) return Promise.resolve({ status: 'absent' });
    if (etag && etag === f.sha) return Promise.resolve({ status: 'unchanged', etag });
    return Promise.resolve({ status: 'ok', data: f.data, sha: f.sha, etag: f.sha });
  }),
}));

const panicSpy = vi.fn();
vi.mock('../../lib/panic-wipe', () => ({ panicWipe: (...a: unknown[]) => panicSpy(...a) }));

const PARANOID_FLAG = 'gtd25-paranoid';
const LAP = 'laptop-1';
const PHONE = 'phone-1';
const PASS = 'remote unlock test passphrase';
const REPO = 'me/repo';
const PAT = 'ghp_test';

async function fastMacKey(seed = 9): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

let macKey: CryptoKey;
let phoneIdentity: Awaited<ReturnType<typeof generateIdentityKeys>>;
let laptopLocal: LocalSettings;
let phoneLocal: LocalSettings;

async function snapshotLocal(): Promise<LocalSettings> {
  return { ...(await db.localSettings.get('local'))! };
}
async function actAsLaptop(): Promise<void> {
  await db.localSettings.put(laptopLocal);
  localStorage.setItem(PARANOID_FLAG, '1');
}
async function actAsPhone(): Promise<void> {
  await db.localSettings.put(phoneLocal);
  localStorage.removeItem(PARANOID_FLAG);
}

// Bring two enrolled devices to a steady state: laptop (paranoid, unlocked) has
// enrolled the phone (non-paranoid) as approver, and the phone has accepted.
async function enrollPair(): Promise<void> {
  // Laptop: configure sync creds, enable paranoid (unlocked), enroll the phone.
  await db.localSettings.update('local', {
    deviceId: LAP, githubRepo: REPO, githubPat: PAT, encryptionPassword: 'syncpw', syncEnabled: true,
  });
  await vault.enableParanoid(PASS);
  // The phone publishes its (authentic, non-paranoid) registry entry.
  await ru.publishRegistryEntry(PAT, REPO, await ru.buildRegistryEntry(PHONE, 'My Phone', publicIdentityOf(phoneIdentity), false, macKey));
  // Laptop enrolls the phone.
  await ru.enableRemoteUnlock({ pat: PAT, repo: REPO, deviceId: LAP, deviceName: 'Work Laptop', macKey }, [PHONE]);
  laptopLocal = await snapshotLocal();

  // Phone accepts the RUK invite.
  phoneLocal = { id: 'local', syncEnabled: true, syncIntervalMs: 300_000, deviceId: PHONE, githubRepo: REPO, deviceIdentity: phoneIdentity, deviceName: 'My Phone', paranoidEnabled: false };
  await actAsPhone();
  const accepted = await ru.pollApproverInbox(PAT, REPO, PHONE);
  expect(accepted).toBe(1);
  phoneLocal = await snapshotLocal();
}

beforeEach(async () => {
  files = {};
  panicSpy.mockClear();
  localStorage.removeItem(PARANOID_FLAG);
  localStorage.removeItem('gtd25-paranoid-key');
  await resetDb();
  vault.__resetVaultStateForTests();
  macKey = await fastMacKey();
  phoneIdentity = await generateIdentityKeys();
});

describe('remote unlock: enrollment', () => {
  it('enrolls a non-paranoid approver, wraps the DEK under RUK, keeps PAT usable while locked', async () => {
    await enrollPair();
    const v = await db.vault.get('vault');
    expect(v?.dekWrappedByRuk).toBeTruthy();
    expect(v?.remoteUnlock?.approvers.map((a) => a.deviceId)).toEqual([PHONE]);
    // The phone holds RUK; the laptop does not.
    expect(phoneLocal.remoteApproverFor?.[LAP]?.ruk).toBeTruthy();
    // PAT is plaintext (usable while locked).
    expect(laptopLocal.githubPat).toBe(PAT);
  });

  it('refuses to enroll a Paranoid device as an approver', async () => {
    await db.localSettings.update('local', { deviceId: LAP, githubRepo: REPO, githubPat: PAT, encryptionPassword: 'p', syncEnabled: true });
    await vault.enableParanoid(PASS);
    // Phone publishes itself as paranoid:true (not eligible).
    await ru.publishRegistryEntry(PAT, REPO, await ru.buildRegistryEntry(PHONE, 'Other paranoid', publicIdentityOf(phoneIdentity), true, macKey));
    // The paranoid:true candidate is filtered out, leaving no eligible approver.
    await expect(ru.enableRemoteUnlock({ pat: PAT, repo: REPO, deviceId: LAP, deviceName: 'Lap', macKey }, [PHONE]))
      .rejects.toThrow(/eligible \(non-Paranoid\) approver/);
  });
});

describe('remote unlock: full exchange', () => {
  it('locks, requests, approves with a matching code, and unlocks', async () => {
    await enrollPair();

    // Laptop locks and requests a remote unlock.
    await actAsLaptop();
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    const { code } = await ru.requestRemoteUnlock(PAT, REPO, LAP);
    expect(code).toMatch(/^\d{2}-\d{2}$/);

    // Phone sees the request; the displayed code MATCHES the laptop's.
    await actAsPhone();
    const pending = await ru.readPendingApproval(PAT, REPO, LAP);
    expect(pending?.fromName).toBe('Work Laptop');
    expect(pending?.code).toBe(code);
    await ru.approveRemoteUnlock(PAT, REPO, LAP);

    // Laptop polls the response and unlocks.
    await actAsLaptop();
    const res = await ru.pollRemoteUnlock(PAT, REPO, LAP);
    expect(res.status).toBe('unlocked');
    expect(vault.isUnlocked()).toBe(true);
  });

  it('rejects a stale request and a request with a tampered signature', async () => {
    await enrollPair();
    await actAsLaptop();
    vault.lock();
    await ru.requestRemoteUnlock(PAT, REPO, LAP);

    // Tamper the stored request signature -> approver rejects it.
    const reqPath = ru.unlockReqPath(LAP);
    const req = JSON.parse(files[reqPath].data);
    files[reqPath] = { data: JSON.stringify({ ...req, sig: 'bm90LXNpZw==' }), sha: 'x' };
    await actAsPhone();
    expect(await ru.readPendingApproval(PAT, REPO, LAP)).toBeNull();

    // Stale request (ts far in the past) -> rejected.
    files[reqPath] = { data: JSON.stringify({ ...req, ts: Date.now() - 10 * 60_000 }), sha: 'y' };
    expect(await ru.readPendingApproval(PAT, REPO, LAP)).toBeNull();
  });

  it('a Paranoid device refuses to approve', async () => {
    await enrollPair();
    await actAsLaptop();
    vault.lock();
    await ru.requestRemoteUnlock(PAT, REPO, LAP);
    // Phone turns paranoid -> must refuse approver duties.
    await actAsPhone();
    localStorage.setItem(PARANOID_FLAG, '1');
    expect(await ru.readPendingApproval(PAT, REPO, LAP)).toBeNull();
    await expect(ru.approveRemoteUnlock(PAT, REPO, LAP)).rejects.toThrow(/Paranoid device cannot approve/);
  });
});

describe('remote wipe', () => {
  it('wipes when an enrolled approver signs the command', async () => {
    await enrollPair();
    // Phone issues the wipe.
    await actAsPhone();
    await ru.sendRemoteWipe(PAT, REPO, LAP);
    // Laptop polls its command file and wipes.
    await actAsLaptop();
    const r = await ru.pollRemoteCommands(PAT, REPO, LAP);
    expect(r.wiped).toBe(true);
    expect(panicSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a wipe command signed by a non-approver (forged)', async () => {
    await enrollPair();
    // Forge a command signed by a stranger key.
    const stranger = await generateIdentityKeys();
    const base = { target: LAP, nonce: 'n1', ts: Date.now() };
    const sig = await signPayload(stranger.ecdsaPriv, new TextEncoder().encode(`wipe|${base.target}|${base.nonce}|${base.ts}`));
    files[ru.cmdPath(LAP)] = { data: JSON.stringify({ ...base, from: 'attacker', sig }), sha: 'c1' };

    await actAsLaptop();
    const r = await ru.pollRemoteCommands(PAT, REPO, LAP);
    expect(r.wiped).toBe(false);
    expect(panicSpy).not.toHaveBeenCalled();
  });

  it('a Paranoid device refuses to issue a wipe', async () => {
    await enrollPair();
    await actAsPhone();
    localStorage.setItem(PARANOID_FLAG, '1');
    await expect(ru.sendRemoteWipe(PAT, REPO, LAP)).rejects.toThrow(/Paranoid device cannot issue/);
  });
});

describe('remote unlock: polling & lifecycle branches', () => {
  it('pollRemoteCommands is a no-op when there is no command', async () => {
    await enrollPair();
    await actAsLaptop();
    const r = await ru.pollRemoteCommands(PAT, REPO, LAP);
    expect(r).toEqual({ etag: null, wiped: false });
    expect(panicSpy).not.toHaveBeenCalled();
  });

  it('ignores an unlock response that does not match the pending nonce', async () => {
    await enrollPair();
    await actAsLaptop();
    vault.lock();
    await ru.requestRemoteUnlock(PAT, REPO, LAP);
    files[ru.unlockRespPath(LAP)] = {
      data: JSON.stringify({ forNonce: 'some-other-nonce', fromApproverDeviceId: PHONE, ts: Date.now(), respBlob: 'x', sig: 'y' }),
      sha: 'r1',
    };
    const res = await ru.pollRemoteUnlock(PAT, REPO, LAP);
    expect(res.status).toBe('waiting');
    expect(vault.isUnlocked()).toBe(false);
  });

  it('disableRemoteUnlock clears the RUK wrapping and re-locks the PAT away', async () => {
    await enrollPair();
    await actAsLaptop();
    await ru.disableRemoteUnlock();
    const v = await db.vault.get('vault');
    expect(v?.dekWrappedByRuk).toBeUndefined();
    expect(v?.remoteUnlock).toBeUndefined();
    expect((await db.localSettings.get('local'))?.githubPat).toBeUndefined();
  });

  it('buildEnrollContext requires sync creds and a cached salt', async () => {
    await db.localSettings.update('local', { deviceId: LAP, githubRepo: REPO, githubPat: PAT, encryptionPassword: 'p', syncEnabled: true });
    await vault.enableParanoid(PASS); // unlocked but never synced -> no cached salt
    await expect(ru.buildEnrollContext()).rejects.toThrow(/sync/i);
  });
});

describe('remote unlock: approver inbox enforcement', () => {
  it('a Paranoid device will not accept approver invites', async () => {
    await enrollPair();
    // Re-invite (laptop) so there is a pending invite, then have the phone go paranoid.
    await actAsPhone();
    await db.localSettings.update('local', { remoteApproverFor: undefined }); // forget prior acceptance
    localStorage.setItem(PARANOID_FLAG, '1');
    expect(await ru.pollApproverInbox(PAT, REPO, PHONE)).toBe(0);
  });
});
