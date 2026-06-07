// Orchestration for Paranoid-Mode remote unlock & wipe: device identity, the
// MAC-authenticated device registry, and mailbox/credential plumbing. Pure crypto
// lives in ./remote-unlock-crypto; this module is the db + backend glue.

import { db } from '../db';
import type { RemoteApproverInfo } from '../db/models';
import {
  generateIdentityKeys, publicIdentityOf, registryMac, verifyRegistryMac,
  registryEntryBytes, type DeviceIdentity, type PublicIdentity,
} from './remote-unlock-crypto';
import { getFile, putFile, deleteFile, getFileConditional, type ConditionalFile } from './github-api';
import {
  eciesEncryptTo, eciesDecrypt, signPayload, verifyPayload, verificationCode,
  b64encode, b64decode, type EciesBlob,
} from './remote-unlock-crypto';
import { encryptBlob, decryptBlob } from './crypto';
import { importKekFromBytes } from '../db/vault-crypto';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { wrapDekWithRuk, unlockWithRemoteKey, clearRemoteUnlock, getVaultSecrets } from '../db/vault';
export { isRemoteUnlockEnrolled } from '../db/vault'; // re-exported so the UI imports it from one place
import { getCachedSalt } from './crypto';
import { deriveRegistryMacKey } from './remote-unlock-crypto';

// --- Mailbox file paths (live in the existing sync repo) ---
export const REGISTRY_PATH = 'gtd25-devices.json';
export const unlockReqPath = (deviceId: string): string => `gtd25-unlock-req-${deviceId}.json`;
export const unlockRespPath = (deviceId: string): string => `gtd25-unlock-resp-${deviceId}.json`;
export const cmdPath = (deviceId: string): string => `gtd25-cmd-${deviceId}.json`;

// --- Device identity (persisted plaintext in localSettings) ---

/** Return this device's identity keypairs, generating + persisting them on first use. */
export async function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const local = await db.localSettings.get('local');
  if (local?.deviceIdentity) return local.deviceIdentity;
  const identity = await generateIdentityKeys();
  await db.localSettings.update('local', { deviceIdentity: identity });
  return identity;
}

export async function getPublicIdentity(): Promise<PublicIdentity | null> {
  const local = await db.localSettings.get('local');
  return local?.deviceIdentity ? publicIdentityOf(local.deviceIdentity) : null;
}

function defaultDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'This device';
}

export async function getDeviceName(): Promise<string> {
  const local = await db.localSettings.get('local');
  return local?.deviceName || defaultDeviceName();
}
export async function setDeviceName(name: string): Promise<void> {
  await db.localSettings.update('local', { deviceName: name.trim() || defaultDeviceName() });
}

/**
 * The plaintext PAT usable while the vault is LOCKED, for the mailbox poll. Present
 * only when remote features are enrolled (enrollment writes it back to plaintext);
 * null otherwise — callers then have no while-locked backend access (by design).
 */
export async function getMailboxPat(): Promise<string | null> {
  const local = await db.localSettings.get('local');
  return local?.githubPat ?? null;
}
export async function getRepo(): Promise<string | null> {
  const local = await db.localSettings.get('local');
  return local?.githubRepo ?? null;
}

// --- Registry (MAC-authenticated; see remote-unlock-crypto + THREAT_MODEL.md) ---

export interface RegistryEntry extends RemoteApproverInfo {
  paranoid: boolean;
  updatedAt: number;
  mac: string;
}
type Registry = Record<string, RegistryEntry>; // keyed by deviceId

export async function buildRegistryEntry(
  deviceId: string, name: string, pub: PublicIdentity, paranoid: boolean, macKey: CryptoKey,
): Promise<RegistryEntry> {
  const base = { deviceId, name, ecdhPub: pub.ecdhPub, ecdsaPub: pub.ecdsaPub, paranoid, updatedAt: Date.now() };
  const mac = await registryMac(macKey, registryEntryBytes(base));
  return { ...base, mac };
}

/** True only if the entry's MAC verifies under the syncPassword-derived key. */
export async function isAuthenticEntry(e: RegistryEntry, macKey: CryptoKey): Promise<boolean> {
  if (!e || typeof e.mac !== 'string' || !e.deviceId || !e.ecdhPub || !e.ecdsaPub) return false;
  return verifyRegistryMac(macKey, e.mac, registryEntryBytes({
    deviceId: e.deviceId, name: e.name, ecdhPub: e.ecdhPub, ecdsaPub: e.ecdsaPub,
    paranoid: e.paranoid, updatedAt: e.updatedAt,
  }));
}

export function mergeEntry(reg: Registry, entry: RegistryEntry): Registry {
  return { ...reg, [entry.deviceId]: entry };
}

function safeParseRegistry(s: string): Registry {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Registry) : {};
  } catch {
    return {};
  }
}

/** Publish/update this device's authenticated registry entry (merges into the file). */
export async function publishRegistryEntry(pat: string, repo: string, entry: RegistryEntry): Promise<void> {
  const existing = await getFile(pat, repo, REGISTRY_PATH);
  const next = mergeEntry(existing ? safeParseRegistry(existing.data) : {}, entry);
  await putFile(pat, repo, REGISTRY_PATH, JSON.stringify(next), existing?.sha);
}

/** Read the registry and return ONLY entries whose MAC verifies (forged/foreign dropped). */
export async function readAuthenticRegistry(pat: string, repo: string, macKey: CryptoKey): Promise<RegistryEntry[]> {
  const file = await getFile(pat, repo, REGISTRY_PATH);
  if (!file) return [];
  const reg = safeParseRegistry(file.data);
  const out: RegistryEntry[] = [];
  for (const e of Object.values(reg)) {
    if (await isAuthenticEntry(e, macKey)) out.push(e);
  }
  return out;
}

// ===========================================================================
// Enrollment, remote wipe, and remote unlock protocol
// ===========================================================================

export const approverInboxPath = (deviceId: string): string => `gtd25-approver-${deviceId}.json`;
const REQUEST_TTL_MS = 2 * 60_000;

function safeParseObj<T>(s: string): Record<string, T> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, T>) : {};
  } catch {
    return {};
  }
}

// --- Canonical byte encodings for signatures (built identically on both ends) ---
const te = new TextEncoder();
function wipeBytes(c: { target: string; nonce: string; ts: number }): Uint8Array {
  return te.encode(`wipe|${c.target}|${c.nonce}|${c.ts}`);
}
function requestBytes(r: { fromDeviceId: string; nonce: string; ts: number; kForApprover: Record<string, EciesBlob> }): Uint8Array {
  const ks = Object.keys(r.kForApprover).sort().map((id) => `${id}:${r.kForApprover[id].epk.x}:${r.kForApprover[id].ct}`).join(',');
  return te.encode(`req|${r.fromDeviceId}|${r.nonce}|${r.ts}|${ks}`);
}
function responseBytes(r: { forNonce: string; fromApproverDeviceId: string; ts: number; respBlob: string }): Uint8Array {
  return te.encode(`resp|${r.forNonce}|${r.fromApproverDeviceId}|${r.ts}|${r.respBlob}`);
}

// --- Wire shapes ---
interface ApproverInvite { fromDeviceId: string; fromName: string; fromEcdsaPub: JsonWebKey; rukEcies: EciesBlob; ts: number }
interface WipeCommand { target: string; nonce: string; ts: number; from: string; sig: string }
interface UnlockRequest { fromDeviceId: string; nonce: string; ts: number; kForApprover: Record<string, EciesBlob>; sig: string }
interface UnlockResponse { forNonce: string; fromApproverDeviceId: string; ts: number; respBlob: string; sig: string }

// === Paranoid device (unlocked): enroll / disable remote unlock+wipe ===

export interface EnrollContext { pat: string; repo: string; deviceId: string; deviceName: string; macKey: CryptoKey }

/**
 * Enroll the chosen (Paranoid-OFF) approver devices. Publishes this device's
 * registry entry, wraps the DEK under a fresh RUK, ECIES-delivers RUK to each
 * approver's inbox, caches approver public keys locally, and keeps the PAT in
 * plaintext so the locked device can poll the mailbox. Requires the vault unlocked.
 */
export async function enableRemoteUnlock(ctx: EnrollContext, approverDeviceIds: string[]): Promise<RegistryEntry[]> {
  const { pat, repo, deviceId, deviceName, macKey } = ctx;
  const identity = await ensureDeviceIdentity();
  await publishRegistryEntry(pat, repo, await buildRegistryEntry(deviceId, deviceName, publicIdentityOf(identity), true, macKey));

  const authentic = await readAuthenticRegistry(pat, repo, macKey);
  const approvers = authentic.filter((e) => approverDeviceIds.includes(e.deviceId) && !e.paranoid && e.deviceId !== deviceId);
  if (approvers.length === 0) throw new Error('Select at least one eligible (non-Paranoid) approver device');

  const ruk = crypto.getRandomValues(new Uint8Array(32));
  try {
    await wrapDekWithRuk(ruk);
    for (const a of approvers) {
      const rukEcies = await eciesEncryptTo(a.ecdhPub, ruk);
      await postApproverInvite(pat, repo, a.deviceId, {
        fromDeviceId: deviceId, fromName: deviceName, fromEcdsaPub: identity.ecdsaPub, rukEcies, ts: Date.now(),
      });
    }
  } finally {
    ruk.fill(0);
  }

  await db.vault.update('vault', {
    remoteUnlock: { approvers: approvers.map((a) => ({ deviceId: a.deviceId, name: a.name, ecdhPub: a.ecdhPub, ecdsaPub: a.ecdsaPub })) },
  });
  // Keep the PAT plaintext so the locked device can reach the mailbox.
  await db.localSettings.update('local', { githubPat: pat });
  return approvers;
}

/** Tear down remote unlock on this (paranoid) device and re-lock the PAT away. */
export async function disableRemoteUnlock(): Promise<void> {
  await clearRemoteUnlock();
  if (isParanoidFlagSet()) {
    // PAT goes back to vault-only (it remains encrypted in vault.secrets).
    await db.localSettings.update('local', { githubPat: undefined });
  }
}

async function postApproverInvite(pat: string, repo: string, approverDeviceId: string, invite: ApproverInvite): Promise<void> {
  const path = approverInboxPath(approverDeviceId);
  const existing = await getFile(pat, repo, path);
  const inbox = existing ? safeParseObj<ApproverInvite>(existing.data) : {};
  inbox[invite.fromDeviceId] = invite;
  await putFile(pat, repo, path, JSON.stringify(inbox), existing?.sha);
}

// === Approver device (Paranoid OFF): accept invites, approve, wipe ===

/**
 * Pick up RUK invites addressed to this device and store them. Refuses entirely
 * if THIS device is in Paranoid Mode (a Paranoid device must never be an approver).
 * Returns the number of newly-accepted enrollments.
 */
export async function pollApproverInbox(pat: string, repo: string, deviceId: string): Promise<number> {
  if (isParanoidFlagSet()) return 0;
  const file = await getFile(pat, repo, approverInboxPath(deviceId));
  if (!file) return 0;
  const inbox = safeParseObj<ApproverInvite>(file.data);
  const identity = await ensureDeviceIdentity();
  const local = await db.localSettings.get('local');
  const store = { ...(local?.remoteApproverFor ?? {}) };
  let accepted = 0;
  for (const invite of Object.values(inbox)) {
    if (!invite?.fromDeviceId || store[invite.fromDeviceId]) continue;
    try {
      const ruk = await eciesDecrypt(identity.ecdhPriv, invite.rukEcies);
      store[invite.fromDeviceId] = { ruk: b64encode(ruk), ecdsaPub: invite.fromEcdsaPub, name: invite.fromName };
      ruk.fill(0);
      accepted++;
    } catch { /* not for us / corrupt */ }
  }
  if (accepted) await db.localSettings.update('local', { remoteApproverFor: store });
  return accepted;
}

/** Devices this (approver) device is enrolled to unlock/wipe. */
export async function listApprovedDevices(): Promise<Array<{ deviceId: string; name: string }>> {
  const local = await db.localSettings.get('local');
  return Object.entries(local?.remoteApproverFor ?? {}).map(([deviceId, v]) => ({ deviceId, name: v.name }));
}

/** Approver: sign and post a remote-wipe command for an enrolled device. */
export async function sendRemoteWipe(pat: string, repo: string, targetDeviceId: string): Promise<void> {
  if (isParanoidFlagSet()) throw new Error('A Paranoid device cannot issue remote-wipe commands');
  const local = await db.localSettings.get('local');
  const me = local?.deviceId ?? 'unknown';
  if (!local?.remoteApproverFor?.[targetDeviceId]) throw new Error('Not enrolled to manage that device');
  const identity = await ensureDeviceIdentity();
  const base = { target: targetDeviceId, nonce: crypto.randomUUID(), ts: Date.now() };
  const sig = await signPayload(identity.ecdsaPriv, wipeBytes(base));
  const cmd: WipeCommand = { ...base, from: me, sig };
  const path = cmdPath(targetDeviceId);
  const existing = await getFile(pat, repo, path);
  await putFile(pat, repo, path, JSON.stringify(cmd), existing?.sha);
}

// === Locked device: poll for commands (wipe) and unlock responses ===

/**
 * Poll this device's command file; if it carries a wipe command validly signed by
 * ANY enrolled approver, run panicWipe(). Uses a conditional request (etag) so
 * repeated polls are rate-limit-free; pass the prior etag, store the returned one.
 */
export async function pollRemoteCommands(pat: string, repo: string, deviceId: string, etag?: string | null): Promise<{ etag: string | null; wiped: boolean }> {
  const res: ConditionalFile = await getFileConditional(pat, repo, cmdPath(deviceId), etag);
  if (res.status === 'unchanged') return { etag: res.etag, wiped: false };
  if (res.status === 'absent') return { etag: null, wiped: false };

  const cmd = (() => { try { return JSON.parse(res.data) as WipeCommand; } catch { return null; } })();
  if (cmd && cmd.target === deviceId && typeof cmd.sig === 'string') {
    const approvers = await approverVerifyKeys();
    for (const ecdsaPub of approvers) {
      if (await verifyPayload(ecdsaPub, cmd.sig, wipeBytes({ target: cmd.target, nonce: cmd.nonce, ts: cmd.ts }))) {
        const { panicWipe } = await import('../lib/panic-wipe');
        await panicWipe();
        return { etag: res.etag, wiped: true };
      }
    }
  }
  return { etag: res.etag, wiped: false };
}

/** Cached approver verify-keys for THIS protected device (from the vault). */
async function approverVerifyKeys(): Promise<JsonWebKey[]> {
  const vault = await db.vault.get('vault');
  return (vault?.remoteUnlock?.approvers ?? []).map((a) => a.ecdsaPub);
}

// --- Unlock exchange (laptop side, while locked) ---

let pendingUnlock: { nonce: string; k: Uint8Array; code: string } | null = null;

/** Build + post an unlock request to all enrolled approvers; returns the code to display. */
export async function requestRemoteUnlock(pat: string, repo: string, deviceId: string): Promise<{ code: string }> {
  const vault = await db.vault.get('vault');
  const approvers = vault?.remoteUnlock?.approvers ?? [];
  if (approvers.length === 0) throw new Error('No trusted devices are enrolled');
  const local = await db.localSettings.get('local');
  const identity = local?.deviceIdentity;
  if (!identity) throw new Error('This device has no identity key');

  const k = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const kForApprover: Record<string, EciesBlob> = {};
  for (const a of approvers) kForApprover[a.deviceId] = await eciesEncryptTo(a.ecdhPub, k);

  const sig = await signPayload(identity.ecdsaPriv, requestBytes({ fromDeviceId: deviceId, nonce, ts, kForApprover }));
  const req: UnlockRequest = { fromDeviceId: deviceId, nonce, ts, kForApprover, sig };
  const path = unlockReqPath(deviceId);
  const existing = await getFile(pat, repo, path);
  await putFile(pat, repo, path, JSON.stringify(req), existing?.sha);

  const code = await verificationCode(concat(k, te.encode(nonce)));
  pendingUnlock = { nonce, k, code };
  return { code };
}

export function cancelRemoteUnlock(): void {
  if (pendingUnlock) { pendingUnlock.k.fill(0); pendingUnlock = null; }
}

/**
 * Poll for an approver's response to the pending request. On a valid, approver-
 * signed response, decrypt RUK with the in-RAM session key and unlock. Returns
 * 'unlocked' | 'waiting'. Uses conditional requests for cheap polling.
 */
export async function pollRemoteUnlock(pat: string, repo: string, deviceId: string, etag?: string | null): Promise<{ etag: string | null; status: 'unlocked' | 'waiting' }> {
  if (!pendingUnlock) return { etag: etag ?? null, status: 'waiting' };
  const res = await getFileConditional(pat, repo, unlockRespPath(deviceId), etag);
  if (res.status !== 'ok') return { etag: res.status === 'unchanged' ? res.etag : null, status: 'waiting' };

  const resp = (() => { try { return JSON.parse(res.data) as UnlockResponse; } catch { return null; } })();
  if (!resp || resp.forNonce !== pendingUnlock.nonce) return { etag: res.etag, status: 'waiting' };

  const vault = await db.vault.get('vault');
  const approver = (vault?.remoteUnlock?.approvers ?? []).find((a) => a.deviceId === resp.fromApproverDeviceId);
  if (!approver) return { etag: res.etag, status: 'waiting' };
  const ok = await verifyPayload(approver.ecdsaPub, resp.sig, responseBytes({
    forNonce: resp.forNonce, fromApproverDeviceId: resp.fromApproverDeviceId, ts: resp.ts, respBlob: resp.respBlob,
  }));
  if (!ok) return { etag: res.etag, status: 'waiting' };

  try {
    const sessionKey = await importKekFromBytes(pendingUnlock.k);
    const rukB64 = await decryptBlob(sessionKey, resp.respBlob);
    const ruk = b64decode(rukB64);
    const unlocked = await unlockWithRemoteKey(ruk);
    ruk.fill(0);
    if (unlocked) {
      cancelRemoteUnlock();
      // consume the response so it can't be replayed
      try { const f = await getFile(pat, repo, unlockRespPath(deviceId)); if (f) await deleteFile(pat, repo, unlockRespPath(deviceId), f.sha); } catch { /* best effort */ }
      return { etag: res.etag, status: 'unlocked' };
    }
  } catch { /* fall through */ }
  return { etag: res.etag, status: 'waiting' };
}

// --- Unlock exchange (approver side) ---

export interface PendingApproval { fromDeviceId: string; fromName: string; nonce: string; code: string }

/**
 * Approver: read a pending unlock request from a managed device, verify its
 * signature + freshness, and return the request + verification code to show the
 * user. Returns null if none / invalid / not enrolled / this device is Paranoid.
 */
export async function readPendingApproval(pat: string, repo: string, fromDeviceId: string): Promise<PendingApproval | null> {
  if (isParanoidFlagSet()) return null;
  const local = await db.localSettings.get('local');
  const entry = local?.remoteApproverFor?.[fromDeviceId];
  if (!entry) return null;
  const file = await getFile(pat, repo, unlockReqPath(fromDeviceId));
  if (!file) return null;
  const req = (() => { try { return JSON.parse(file.data) as UnlockRequest; } catch { return null; } })();
  if (!req || req.fromDeviceId !== fromDeviceId) return null;
  if (Date.now() - req.ts > REQUEST_TTL_MS) return null; // stale / replay
  const myId = local?.deviceId ?? '';
  const myBlob = req.kForApprover[myId];
  if (!myBlob) return null;
  if (!(await verifyPayload(entry.ecdsaPub, req.sig, requestBytes({ fromDeviceId: req.fromDeviceId, nonce: req.nonce, ts: req.ts, kForApprover: req.kForApprover })))) {
    return null;
  }
  const identity = await ensureDeviceIdentity();
  let k: Uint8Array;
  try { k = await eciesDecrypt(identity.ecdhPriv, myBlob); } catch { return null; }
  const code = await verificationCode(concat(k, te.encode(req.nonce)));
  k.fill(0);
  return { fromDeviceId, fromName: entry.name, nonce: req.nonce, code };
}

/**
 * Approver: APPROVE a pending request — re-derive the session key, wrap RUK under
 * it, sign, and post the response. The user must have matched the code first.
 */
export async function approveRemoteUnlock(pat: string, repo: string, fromDeviceId: string): Promise<void> {
  if (isParanoidFlagSet()) throw new Error('A Paranoid device cannot approve remote unlock');
  const local = await db.localSettings.get('local');
  const entry = local?.remoteApproverFor?.[fromDeviceId];
  if (!entry) throw new Error('Not enrolled for that device');
  const myId = local?.deviceId ?? '';
  const file = await getFile(pat, repo, unlockReqPath(fromDeviceId));
  if (!file) throw new Error('No unlock request found');
  const req = JSON.parse(file.data) as UnlockRequest;
  if (Date.now() - req.ts > REQUEST_TTL_MS) throw new Error('Request expired');
  const identity = await ensureDeviceIdentity();
  const k = await eciesDecrypt(identity.ecdhPriv, req.kForApprover[myId]);
  try {
    const sessionKey = await importKekFromBytes(k);
    const respBlob = await encryptBlob(sessionKey, entry.ruk); // entry.ruk is base64; recovered as base64 on the other end
    const ts = Date.now();
    const sig = await signPayload(identity.ecdsaPriv, responseBytes({ forNonce: req.nonce, fromApproverDeviceId: myId, ts, respBlob }));
    const resp: UnlockResponse = { forNonce: req.nonce, fromApproverDeviceId: myId, ts, respBlob, sig };
    const path = unlockRespPath(fromDeviceId);
    const existing = await getFile(pat, repo, path);
    await putFile(pat, repo, path, JSON.stringify(resp), existing?.sha);
  } finally {
    k.fill(0);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

// === High-level helpers for the UI ===

/**
 * The sync password, wherever it currently lives: in the unlocked vault (Paranoid
 * Mode) or plaintext in localSettings (non-Paranoid). Needed by both the protected
 * device and the approver to derive the registry MAC key.
 */
async function getSyncPassword(): Promise<string | null> {
  const fromVault = getVaultSecrets()?.syncPassword;
  if (fromVault) return fromVault;
  const local = await db.localSettings.get('local');
  return local?.encryptionPassword ?? null;
}

/** The PAT, wherever it currently lives (vault when Paranoid+unlocked, else localSettings). */
async function getActivePat(): Promise<string | null> {
  const fromVault = getVaultSecrets()?.githubPat;
  if (fromVault) return fromVault;
  const local = await db.localSettings.get('local');
  return local?.githubPat ?? null;
}

/** Registry MAC key from the current syncPassword + the cached sync salt, or null. */
export async function getRegistryMacKey(): Promise<CryptoKey | null> {
  const sp = await getSyncPassword();
  const salt = getCachedSalt();
  if (!sp || !salt) return null;
  return deriveRegistryMacKey(sp, salt);
}

/**
 * Publish/refresh THIS device's authenticated registry entry so other devices can
 * discover and trust it (a Paranoid-OFF device becomes an eligible approver
 * candidate; a Paranoid device advertises itself as ineligible). No-op (returns
 * false) until sync is set up and the encryption salt is cached. Safe to call
 * repeatedly; callers throttle.
 */
export async function publishOwnRegistryEntry(): Promise<boolean> {
  const local = await db.localSettings.get('local');
  const pat = await getActivePat();
  const repo = local?.githubRepo;
  const deviceId = local?.deviceId;
  const macKey = await getRegistryMacKey();
  if (!pat || !repo || !deviceId || !macKey) return false;
  const identity = await ensureDeviceIdentity();
  const entry = await buildRegistryEntry(deviceId, await getDeviceName(), publicIdentityOf(identity), isParanoidFlagSet(), macKey);
  await publishRegistryEntry(pat, repo, entry);
  return true;
}

/** Gather everything needed to enroll approvers (requires unlocked vault + a prior sync). */
export async function buildEnrollContext(): Promise<EnrollContext> {
  const local = await db.localSettings.get('local');
  const secrets = getVaultSecrets();
  const macKey = await getRegistryMacKey();
  if (!secrets?.githubPat || !local?.githubRepo || !local.deviceId || !macKey) {
    throw new Error('Set up sync and sync at least once (so the encryption salt is available), then unlock the vault');
  }
  return { pat: secrets.githubPat, repo: local.githubRepo, deviceId: local.deviceId, deviceName: await getDeviceName(), macKey };
}

/** Authentic, non-Paranoid, OTHER devices eligible to be approvers. */
export async function listApproverCandidates(): Promise<RegistryEntry[]> {
  const ctx = await buildEnrollContext();
  const reg = await readAuthenticRegistry(ctx.pat, ctx.repo, ctx.macKey);
  return reg.filter((e) => !e.paranoid && e.deviceId !== ctx.deviceId);
}

/** Cached approver display info for the enrolled (protected) device. */
export async function listEnrolledApprovers(): Promise<Array<{ deviceId: string; name: string }>> {
  const vault = await db.vault.get('vault');
  return (vault?.remoteUnlock?.approvers ?? []).map((a) => ({ deviceId: a.deviceId, name: a.name }));
}
