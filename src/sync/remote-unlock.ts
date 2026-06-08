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
import { wrapDekWithRuk, unlockWithRemoteKey, clearRemoteUnlock, getVaultSecrets, getRukRaw } from '../db/vault';
export { isRemoteUnlockEnrolled } from '../db/vault'; // re-exported so the UI imports it from one place
import { getCachedSalt } from './crypto';
import { deriveRegistryMacKey } from './remote-unlock-crypto';
import { recordError } from '../lib/diagnostics';

// --- Mailbox file paths (live in the existing sync repo) ---
export const REGISTRY_PATH = 'gtd25-devices.json';
export const unlockReqPath = (deviceId: string): string => `gtd25-unlock-req-${deviceId}.json`;
export const unlockRespPath = (deviceId: string): string => `gtd25-unlock-resp-${deviceId}.json`;
export const cmdPath = (deviceId: string): string => `gtd25-cmd-${deviceId}.json`;
export const wipeStatusPath = (deviceId: string): string => `gtd25-wipe-status-${deviceId}.json`;

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
function wipeStatusBytes(s: {
  target: string;
  commandNonce: string;
  commandTs: number;
  wipedAt: number;
  fromApproverDeviceId: string;
  protectedDeviceId: string;
}): Uint8Array {
  return te.encode(`wipe-status|${s.target}|${s.commandNonce}|${s.commandTs}|${s.wipedAt}|${s.fromApproverDeviceId}|${s.protectedDeviceId}`);
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
interface WipeStatus { target: string; commandNonce: string; commandTs: number; wipedAt: number; fromApproverDeviceId: string; protectedDeviceId: string; sig: string }
interface UnlockRequest { fromDeviceId: string; nonce: string; ts: number; kForApprover: Record<string, EciesBlob>; sig: string }
interface UnlockResponse { forNonce: string; fromApproverDeviceId: string; ts: number; respBlob: string; sig: string }

export interface ManagedDevice {
  deviceId: string;
  name: string;
  lastWipeCommand?: { nonce: string; sentAt: number };
  lastWipeAck?: { commandNonce: string; wipedAt: number; verifiedAt: number };
}

export interface WipeCommandReceipt {
  nonce: string;
  ts: number;
}

export interface VerifiedWipeStatus {
  commandNonce: string;
  commandTs: number;
  wipedAt: number;
  fromApproverDeviceId: string;
}

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

/**
 * Add MORE approver devices to an already-enrolled circle WITHOUT re-keying the
 * existing ones: recover the stable RUK (needs the vault unlocked) and ECIES-deliver
 * it to each new approver, then append them to the cached approver list.
 */
export async function addApprovers(ctx: EnrollContext, approverDeviceIds: string[]): Promise<RegistryEntry[]> {
  const { pat, repo, deviceId, deviceName, macKey } = ctx;
  const ruk = await getRukRaw();
  if (!ruk) throw new Error('Unlock the vault first (remote unlock must already be set up here)');
  const authentic = await readAuthenticRegistry(pat, repo, macKey);
  const vault = await db.vault.get('vault');
  const existing = new Set((vault?.remoteUnlock?.approvers ?? []).map((a) => a.deviceId));
  const toAdd = authentic.filter((e) => approverDeviceIds.includes(e.deviceId) && !e.paranoid && e.deviceId !== deviceId && !existing.has(e.deviceId));
  if (toAdd.length === 0) throw new Error('Select at least one new eligible (non-Paranoid) device');
  const identity = await ensureDeviceIdentity();
  try {
    for (const a of toAdd) {
      const rukEcies = await eciesEncryptTo(a.ecdhPub, ruk);
      await postApproverInvite(pat, repo, a.deviceId, { fromDeviceId: deviceId, fromName: deviceName, fromEcdsaPub: identity.ecdsaPub, rukEcies, ts: Date.now() });
    }
  } finally {
    ruk.fill(0);
  }
  const merged = [...(vault?.remoteUnlock?.approvers ?? []), ...toAdd.map((a) => ({ deviceId: a.deviceId, name: a.name, ecdhPub: a.ecdhPub, ecdsaPub: a.ecdsaPub }))];
  await db.vault.update('vault', { remoteUnlock: { approvers: merged } });
  return toAdd;
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

async function writeApproverInbox(pat: string, repo: string, approverDeviceId: string, inbox: Record<string, ApproverInvite>, sha: string): Promise<void> {
  const path = approverInboxPath(approverDeviceId);
  if (Object.keys(inbox).length === 0) {
    await deleteFile(pat, repo, path, sha);
  } else {
    await putFile(pat, repo, path, JSON.stringify(inbox), sha);
  }
}

async function removeApproverInvite(pat: string, repo: string, approverDeviceId: string, fromDeviceId: string): Promise<void> {
  const file = await getFile(pat, repo, approverInboxPath(approverDeviceId));
  if (!file) return;
  const inbox = safeParseObj<ApproverInvite>(file.data);
  if (!Object.prototype.hasOwnProperty.call(inbox, fromDeviceId)) return;
  delete inbox[fromDeviceId];
  await writeApproverInbox(pat, repo, approverDeviceId, inbox, file.sha);
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
  const consumedInviteIds = new Set<string>();
  let accepted = 0;
  for (const invite of Object.values(inbox)) {
    if (!invite?.fromDeviceId) continue;
    if (store[invite.fromDeviceId]) {
      consumedInviteIds.add(invite.fromDeviceId);
      continue;
    }
    try {
      const ruk = await eciesDecrypt(identity.ecdhPriv, invite.rukEcies);
      store[invite.fromDeviceId] = { ruk: b64encode(ruk), ecdsaPub: invite.fromEcdsaPub, name: invite.fromName };
      ruk.fill(0);
      consumedInviteIds.add(invite.fromDeviceId);
      accepted++;
    } catch { /* not for us / corrupt */ }
  }
  if (accepted) await db.localSettings.update('local', { remoteApproverFor: store });
  if (consumedInviteIds.size > 0) {
    for (const id of consumedInviteIds) delete inbox[id];
    try {
      await writeApproverInbox(pat, repo, deviceId, inbox, file.sha);
    } catch (err) {
      recordError('remoteUnlock.consumeApproverInvite', err);
    }
  }
  return accepted;
}

/** Devices this (approver) device is enrolled to unlock/wipe. */
export async function listApprovedDevices(): Promise<ManagedDevice[]> {
  const local = await db.localSettings.get('local');
  return Object.entries(local?.remoteApproverFor ?? {}).map(([deviceId, v]) => ({
    deviceId,
    name: v.name,
    lastWipeCommand: v.lastWipeCommand,
    lastWipeAck: v.lastWipeAck,
  }));
}

/** Approver: sign and post a remote-wipe command for an enrolled device. */
export async function sendRemoteWipe(pat: string, repo: string, targetDeviceId: string): Promise<WipeCommandReceipt> {
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
  await updateManagedDevice(targetDeviceId, {
    lastWipeCommand: { nonce: base.nonce, sentAt: base.ts },
    lastWipeAck: undefined,
  });
  return base;
}

async function updateManagedDevice(
  targetDeviceId: string,
  patch: Partial<ManagedDevice>,
): Promise<void> {
  const local = await db.localSettings.get('local');
  const entry = local?.remoteApproverFor?.[targetDeviceId];
  if (!entry) return;
  await db.localSettings.update('local', {
    remoteApproverFor: {
      ...(local?.remoteApproverFor ?? {}),
      [targetDeviceId]: { ...entry, ...patch },
    },
  });
}

async function deleteRemoteFileIfExists(pat: string, repo: string, path: string): Promise<void> {
  try {
    const file = await getFile(pat, repo, path);
    if (file) await deleteFile(pat, repo, path, file.sha);
  } catch (err) {
    recordError('remoteUnlock.deleteRemoteFile', err);
  }
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
    for (const approver of approvers) {
      if (await verifyPayload(approver.ecdsaPub, cmd.sig, wipeBytes({ target: cmd.target, nonce: cmd.nonce, ts: cmd.ts }))) {
        try {
          await publishWipeStatus(pat, repo, cmd, approver.deviceId, deviceId);
        } catch (err) {
          recordError('remoteUnlock.publishWipeStatus', err);
        }
        const { panicWipe } = await import('../lib/panic-wipe');
        await panicWipe();
        return { etag: res.etag, wiped: true };
      }
    }
  }
  return { etag: res.etag, wiped: false };
}

/** Cached approver verify-keys for THIS protected device (from the vault). */
async function approverVerifyKeys(): Promise<Array<{ deviceId: string; ecdsaPub: JsonWebKey }>> {
  const vault = await db.vault.get('vault');
  return (vault?.remoteUnlock?.approvers ?? []).map((a) => ({ deviceId: a.deviceId, ecdsaPub: a.ecdsaPub }));
}

async function publishWipeStatus(
  pat: string,
  repo: string,
  cmd: WipeCommand,
  fromApproverDeviceId: string,
  protectedDeviceId: string,
): Promise<void> {
  const local = await db.localSettings.get('local');
  const identity = local?.deviceIdentity;
  if (!identity) throw new Error('This device has no identity key for wipe confirmation');
  const base = {
    target: protectedDeviceId,
    commandNonce: cmd.nonce,
    commandTs: cmd.ts,
    wipedAt: Date.now(),
    fromApproverDeviceId,
    protectedDeviceId,
  };
  const sig = await signPayload(identity.ecdsaPriv, wipeStatusBytes(base));
  const status: WipeStatus = { ...base, sig };
  const path = wipeStatusPath(protectedDeviceId);
  const existing = await getFile(pat, repo, path);
  await putFile(pat, repo, path, JSON.stringify(status), existing?.sha, undefined, { keepalive: true });
}

export async function readRemoteWipeStatus(
  pat: string,
  repo: string,
  targetDeviceId: string,
): Promise<VerifiedWipeStatus | null> {
  if (isParanoidFlagSet()) return null;
  const local = await db.localSettings.get('local');
  const entry = local?.remoteApproverFor?.[targetDeviceId];
  if (!entry) return null;
  const file = await getFile(pat, repo, wipeStatusPath(targetDeviceId));
  if (!file) return null;
  const status = (() => { try { return JSON.parse(file.data) as WipeStatus; } catch { return null; } })();
  if (!status || status.target !== targetDeviceId || status.protectedDeviceId !== targetDeviceId || typeof status.sig !== 'string') {
    return null;
  }
  const ok = await verifyPayload(entry.ecdsaPub, status.sig, wipeStatusBytes({
    target: status.target,
    commandNonce: status.commandNonce,
    commandTs: status.commandTs,
    wipedAt: status.wipedAt,
    fromApproverDeviceId: status.fromApproverDeviceId,
    protectedDeviceId: status.protectedDeviceId,
  }));
  if (!ok) return null;
  return {
    commandNonce: status.commandNonce,
    commandTs: status.commandTs,
    wipedAt: status.wipedAt,
    fromApproverDeviceId: status.fromApproverDeviceId,
  };
}

async function readOwnRemoteWipeCommand(pat: string, repo: string, targetDeviceId: string): Promise<ManagedDevice['lastWipeCommand'] | null> {
  const local = await db.localSettings.get('local');
  const identity = local?.deviceIdentity;
  const me = local?.deviceId;
  if (!identity || !me) return null;
  const file = await getFile(pat, repo, cmdPath(targetDeviceId));
  if (!file) return null;
  const cmd = (() => { try { return JSON.parse(file.data) as WipeCommand; } catch { return null; } })();
  if (
    !cmd ||
    cmd.target !== targetDeviceId ||
    cmd.from !== me ||
    typeof cmd.nonce !== 'string' ||
    typeof cmd.ts !== 'number' ||
    typeof cmd.sig !== 'string'
  ) {
    return null;
  }
  const ok = await verifyPayload(identity.ecdsaPub, cmd.sig, wipeBytes({ target: cmd.target, nonce: cmd.nonce, ts: cmd.ts }));
  return ok ? { nonce: cmd.nonce, sentAt: cmd.ts } : null;
}

export async function refreshManagedDeviceWipeStatuses(pat: string, repo: string): Promise<ManagedDevice[]> {
  if (isParanoidFlagSet()) return [];
  const local = await db.localSettings.get('local');
  const current = { ...(local?.remoteApproverFor ?? {}) };
  let changed = false;
  for (const [deviceId, entry] of Object.entries(current)) {
    const status = await readRemoteWipeStatus(pat, repo, deviceId);
    if (status) {
      const lastCommand = entry.lastWipeCommand;
      const isCurrentOrNewer = !lastCommand ||
        status.commandNonce === lastCommand.nonce ||
        status.commandTs >= lastCommand.sentAt;
      if (!isCurrentOrNewer) continue;
      current[deviceId] = {
        ...entry,
        lastWipeAck: {
          commandNonce: status.commandNonce,
          wipedAt: status.wipedAt,
          verifiedAt: Date.now(),
        },
      };
      changed = true;
      continue;
    }

    if (entry.lastWipeAck) continue;
    const command = await readOwnRemoteWipeCommand(pat, repo, deviceId);
    if (!command) continue;
    const lastCommand = entry.lastWipeCommand;
    const isNewCommand = !lastCommand ||
      command.nonce !== lastCommand.nonce ||
      command.sentAt !== lastCommand.sentAt;
    if (!isNewCommand) continue;
    current[deviceId] = {
      ...entry,
      lastWipeCommand: command,
      lastWipeAck: undefined,
    };
    changed = true;
  }
  if (changed) await db.localSettings.update('local', { remoteApproverFor: current });
  return listApprovedDevices();
}

export async function purgeManagedDevice(pat: string, repo: string, targetDeviceId: string): Promise<void> {
  if (isParanoidFlagSet()) throw new Error('A Paranoid device cannot manage remote wipe records');
  const status = await readRemoteWipeStatus(pat, repo, targetDeviceId);
  if (status) {
    await updateManagedDevice(targetDeviceId, {
      lastWipeAck: { commandNonce: status.commandNonce, wipedAt: status.wipedAt, verifiedAt: Date.now() },
    });
  }
  const local = await db.localSettings.get('local');
  const current = { ...(local?.remoteApproverFor ?? {}) };
  const entry = current[targetDeviceId];
  if (!entry?.lastWipeAck) throw new Error('Purge is only available after a verified wipe confirmation');
  if (!local?.deviceId) throw new Error('This trusted device has no device ID');

  await removeApproverInvite(pat, repo, local.deviceId, targetDeviceId);
  await Promise.all([
    deleteRemoteFileIfExists(pat, repo, cmdPath(targetDeviceId)),
    deleteRemoteFileIfExists(pat, repo, wipeStatusPath(targetDeviceId)),
    deleteRemoteFileIfExists(pat, repo, unlockReqPath(targetDeviceId)),
    deleteRemoteFileIfExists(pat, repo, unlockRespPath(targetDeviceId)),
  ]);
  delete current[targetDeviceId];
  await db.localSettings.update('local', { remoteApproverFor: current });
}

export async function forgetManagedDeviceAfterWipeCommand(pat: string, repo: string, targetDeviceId: string): Promise<void> {
  if (isParanoidFlagSet()) throw new Error('A Paranoid device cannot manage remote wipe records');
  const local = await db.localSettings.get('local');
  const current = { ...(local?.remoteApproverFor ?? {}) };
  const entry = current[targetDeviceId];
  const recoveredCommand = entry ? await readOwnRemoteWipeCommand(pat, repo, targetDeviceId) : null;
  if (!entry?.lastWipeCommand && !recoveredCommand) throw new Error('Send a wipe command before forgetting this device');
  if (entry?.lastWipeAck) throw new Error('Use purge for confirmed wiped devices');
  if (!local?.deviceId) throw new Error('This trusted device has no device ID');

  await removeApproverInvite(pat, repo, local.deviceId, targetDeviceId);
  await Promise.all([
    deleteRemoteFileIfExists(pat, repo, unlockReqPath(targetDeviceId)),
    deleteRemoteFileIfExists(pat, repo, unlockRespPath(targetDeviceId)),
  ]);
  delete current[targetDeviceId];
  await db.localSettings.update('local', { remoteApproverFor: current });
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
      // Consume the response AND the request so it can't be replayed and so other
      // trusted devices' prompts detect it was handled (request gone before expiry).
      try { const r = await getFile(pat, repo, unlockRespPath(deviceId)); if (r) await deleteFile(pat, repo, unlockRespPath(deviceId), r.sha); } catch { /* best effort */ }
      try { const q = await getFile(pat, repo, unlockReqPath(deviceId)); if (q) await deleteFile(pat, repo, unlockReqPath(deviceId), q.sha); } catch { /* best effort */ }
      return { etag: res.etag, status: 'unlocked' };
    }
  } catch { /* fall through */ }
  return { etag: res.etag, status: 'waiting' };
}

// --- Unlock exchange (approver side) ---

export interface PendingApproval { fromDeviceId: string; fromName: string; nonce: string; code: string; expiresAt: number }

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
  return { fromDeviceId, fromName: entry.name, nonce: req.nonce, code, expiresAt: req.ts + REQUEST_TTL_MS };
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

/** Authentic, non-Paranoid, OTHER devices eligible to be approvers (excludes ones
 *  already enrolled, so the same list drives both first-time setup and "add more"). */
export async function listApproverCandidates(): Promise<RegistryEntry[]> {
  const ctx = await buildEnrollContext();
  const reg = await readAuthenticRegistry(ctx.pat, ctx.repo, ctx.macKey);
  const vault = await db.vault.get('vault');
  const enrolled = new Set((vault?.remoteUnlock?.approvers ?? []).map((a) => a.deviceId));
  return reg.filter((e) => !e.paranoid && e.deviceId !== ctx.deviceId && !enrolled.has(e.deviceId));
}

/** Cached approver display info for the enrolled (protected) device. */
export async function listEnrolledApprovers(): Promise<Array<{ deviceId: string; name: string }>> {
  const vault = await db.vault.get('vault');
  return (vault?.remoteUnlock?.approvers ?? []).map((a) => ({ deviceId: a.deviceId, name: a.name }));
}
