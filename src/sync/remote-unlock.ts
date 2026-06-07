// Orchestration for Paranoid-Mode remote unlock & wipe: device identity, the
// MAC-authenticated device registry, and mailbox/credential plumbing. Pure crypto
// lives in ./remote-unlock-crypto; this module is the db + backend glue.

import { db } from '../db';
import type { RemoteApproverInfo } from '../db/models';
import {
  generateIdentityKeys, publicIdentityOf, registryMac, verifyRegistryMac,
  registryEntryBytes, type DeviceIdentity, type PublicIdentity,
} from './remote-unlock-crypto';
import { getFile, putFile } from './github-api';

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
