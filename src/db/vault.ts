// Paranoid Mode vault: in-memory DEK lifecycle, idle re-lock, enable/disable,
// and the credential secrets cache. The DEK never touches disk except wrapped.
//
// Gate flag: the *synchronous* source of truth for "is this device in Paranoid
// Mode" is localStorage['gtd25-paranoid']. It lets the app decide on first paint
// whether to show the lock screen without awaiting IndexedDB (avoiding a flash
// of decrypted UI). The Dexie `vault` row holds the persisted key material and
// migration state; localSettings.paranoidEnabled mirrors the flag for records.

import { db } from './index';
import {
  deriveKey, generateSalt, createVerifier, checkVerifier,
  encryptBlob, decryptBlob, clearEncryptionKey,
} from '../sync/crypto';
import { generateDek, wrapDek, unwrapDek, importKekFromBytes } from './vault-crypto';
import { setVaultKeyProvider } from './vault-middleware';
import { encryptAllAtRest, decryptAllAtRest } from './vault-migration';
import { registerPrfCredential, getPrfOutput } from '../sync/webauthn-prf';
import { PARANOID_FLAG, isParanoidFlagSet } from './paranoid-flag';
import type { Vault } from './models';

// Synchronous mirror of "a biometric credential is enrolled", so the lock screen
// and settings can render the biometric affordance without awaiting IndexedDB.
const BIO_FLAG = 'gtd25-paranoid-bio';
export const DEFAULT_IDLE_MINUTES = 15;

export interface VaultSecrets {
  githubPat?: string;
  syncPassword?: string;
}

// --- In-memory state (never persisted) ---
let currentDek: CryptoKey | null = null;
let currentSecrets: VaultSecrets | null = null;
let idleTimeoutMs = DEFAULT_IDLE_MINUTES * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// --- Reactive snapshot for React (useSyncExternalStore) ---
export interface VaultSnapshot { enabled: boolean; unlocked: boolean; hasBiometric: boolean }
const listeners = new Set<() => void>();
let snapshot = computeSnapshot();

function readFlag(): boolean {
  return isParanoidFlagSet();
}
function setFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(PARANOID_FLAG, '1');
    else localStorage.removeItem(PARANOID_FLAG);
  } catch { /* ignore */ }
}
function readBioFlag(): boolean {
  try { return localStorage.getItem(BIO_FLAG) === '1'; } catch { return false; }
}
function setBioFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(BIO_FLAG, '1');
    else localStorage.removeItem(BIO_FLAG);
  } catch { /* ignore */ }
}
function computeSnapshot(): VaultSnapshot {
  return { enabled: readFlag(), unlocked: currentDek !== null, hasBiometric: readBioFlag() };
}
function emit(): void {
  snapshot = computeSnapshot();
  for (const l of listeners) l();
}

export function subscribeVault(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getVaultSnapshot(): VaultSnapshot {
  return snapshot;
}

export function isParanoidEnabled(): boolean { return readFlag(); }
export function isUnlocked(): boolean { return currentDek !== null; }

// Feed the at-rest key to the DBCore middleware. Reading the key counts as
// activity so active DB use defers the idle re-lock.
setVaultKeyProvider(() => {
  if (currentDek) resetIdleTimer();
  return currentDek;
});

// --- Idle re-lock ---
function resetIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (currentDek) idleTimer = setTimeout(() => { lock(); }, idleTimeoutMs);
}
/** Call on user interaction to defer the idle re-lock. */
export function touchVaultActivity(): void { resetIdleTimer(); }

export function getDEK(): CryptoKey | null { resetIdleTimer(); return currentDek; }
export function getVaultSecrets(): VaultSecrets | null { return currentSecrets; }

/**
 * Merge new sync credentials into the encrypted vault (e.g. when the user edits
 * the PAT or sync password from Settings while in Paranoid Mode). Requires the
 * vault to be unlocked.
 */
export async function setVaultSecrets(patch: VaultSecrets): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before changing credentials');
  currentSecrets = { ...currentSecrets, ...patch };
  await db.vault.update('vault', {
    secrets: await encryptBlob(currentDek, JSON.stringify(currentSecrets)),
  });
}

export function lock(): void {
  currentDek = null;
  currentSecrets = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clearEncryptionKey(); // drop the sync key too
  emit();
}

// --- Enable / disable / unlock ---

export async function enableParanoid(passphrase: string, idleMinutes = DEFAULT_IDLE_MINUTES): Promise<void> {
  if (readFlag()) throw new Error('Paranoid mode is already enabled');
  if (!passphrase) throw new Error('A passphrase is required');

  const dek = await generateDek();
  const passSalt = generateSalt();
  const kek = await deriveKey(passphrase, passSalt);
  const dekWrappedByPass = await wrapDek(kek, dek);
  const verifier = await createVerifier(dek);
  const prfSalt = generateSalt();

  // Snapshot current sync credentials into the vault (encrypted with the DEK).
  const local = await db.localSettings.get('local');
  const secrets: VaultSecrets = { githubPat: local?.githubPat, syncPassword: local?.encryptionPassword };

  // Activate the DEK first so the migration encrypts as it rewrites.
  currentDek = dek;
  currentSecrets = secrets;
  idleTimeoutMs = idleMinutes * 60_000;

  await db.vault.put({
    id: 'vault',
    dekWrappedByPass,
    passSalt,
    prfSalt,
    verifier,
    idleTimeoutMinutes: idleMinutes,
    migrationState: 'encrypting',
  });

  await encryptAllAtRest();

  await db.vault.update('vault', {
    secrets: await encryptBlob(dek, JSON.stringify(secrets)),
    migrationState: 'done',
  });
  // Close the at-rest gap: the PAT and sync password now live (encrypted) in the
  // vault, so strip the plaintext copies from localSettings (which is NOT covered
  // by the at-rest middleware). Sync reads them from getVaultSecrets() henceforth.
  await db.localSettings.update('local', {
    paranoidEnabled: true,
    paranoidIdleTimeoutMinutes: idleMinutes,
    githubPat: undefined,
    encryptionPassword: undefined,
  });

  purgeLocalBackups();
  setFlag(true);
  resetIdleTimer();
  emit();
}

export async function disableParanoid(): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before disabling Paranoid Mode');
  await db.vault.update('vault', { migrationState: 'decrypting' });
  await completeDisable();
}

async function completeDisable(): Promise<void> {
  await decryptAllAtRest();
  // Restore the plaintext credentials to localSettings so non-paranoid sync works.
  const restored = currentSecrets;
  await db.localSettings.update('local', {
    paranoidEnabled: false,
    githubPat: restored?.githubPat,
    encryptionPassword: restored?.syncPassword,
  });
  await db.vault.delete('vault'); // delete LAST so an interrupted disable can resume
  setFlag(false);
  setBioFlag(false);
  currentDek = null;
  currentSecrets = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clearEncryptionKey();
  emit();
}

/** Returns false on a wrong passphrase; true once unlocked. */
export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  const vault = await db.vault.get('vault');
  if (!vault) return false;

  const kek = await deriveKey(passphrase, vault.passSalt);
  let dek: CryptoKey;
  try {
    dek = await unwrapDek(kek, vault.dekWrappedByPass);
  } catch {
    return false; // wrong passphrase -> AES-GCM auth failure
  }
  return finishUnlock(vault, dek);
}

/**
 * Unlock via a registered WebAuthn biometric credential. Returns false when no
 * biometric is enrolled, the user cancels, or the derived key is wrong — the
 * caller then falls back to the passphrase.
 */
export async function unlockWithPrf(): Promise<boolean> {
  const vault = await db.vault.get('vault');
  if (!vault?.dekWrappedByPrf || !vault.webauthnCredentialId || !vault.prfSalt) return false;

  const prfOutput = await getPrfOutput(vault.webauthnCredentialId, vault.prfSalt);
  if (!prfOutput) return false;

  const kek = await importKekFromBytes(prfOutput);
  let dek: CryptoKey;
  try {
    dek = await unwrapDek(kek, vault.dekWrappedByPrf);
  } catch {
    return false; // PRF output didn't reconstruct the KEK
  }
  return finishUnlock(vault, dek);
}

// Shared tail of every unlock path: verify the DEK, hydrate in-memory state,
// resume any interrupted migration, and notify subscribers.
async function finishUnlock(vault: Vault, dek: CryptoKey): Promise<boolean> {
  if (!(await checkVerifier(dek, vault.verifier))) return false;

  currentDek = dek;
  idleTimeoutMs = (vault.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  currentSecrets = vault.secrets
    ? (JSON.parse(await decryptBlob(dek, vault.secrets)) as VaultSecrets)
    : null;

  // Resume an interrupted migration.
  if (vault.migrationState === 'encrypting') {
    await encryptAllAtRest();
    await db.vault.update('vault', { migrationState: 'done' });
  } else if (vault.migrationState === 'decrypting') {
    await completeDisable();
    return true;
  }

  resetIdleTimer();
  emit();
  return true;
}

/**
 * Enroll a platform biometric as a second way to unlock: wrap the live DEK with
 * a KEK derived from the authenticator's PRF output. Requires the vault to be
 * unlocked. Returns false if WebAuthn/PRF is unavailable or the user cancels.
 */
export async function addBiometric(): Promise<boolean> {
  if (!currentDek) throw new Error('Unlock the vault before adding biometric unlock');
  const vault = await db.vault.get('vault');
  if (!vault) throw new Error('Vault not found');

  const prfSalt = vault.prfSalt ?? generateSalt();
  const reg = await registerPrfCredential(prfSalt);
  if (!reg) return false;

  const kek = await importKekFromBytes(reg.prfOutput);
  const dekWrappedByPrf = await wrapDek(kek, currentDek);
  await db.vault.update('vault', {
    prfSalt,
    dekWrappedByPrf,
    webauthnCredentialId: reg.credentialId,
  });
  setBioFlag(true);
  emit();
  return true;
}

/** Drop the enrolled biometric; passphrase remains the only unlock method. */
export async function removeBiometric(): Promise<void> {
  // Setting a property to undefined deletes it from the stored row (Dexie).
  await db.vault.update('vault', { dekWrappedByPrf: undefined, webauthnCredentialId: undefined });
  setBioFlag(false);
  emit();
}

/** Re-wrap the DEK under a new passphrase. Requires the vault to be unlocked. */
export async function changePassphrase(newPassphrase: string): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before changing the passphrase');
  if (!newPassphrase) throw new Error('A passphrase is required');
  const passSalt = generateSalt();
  const kek = await deriveKey(newPassphrase, passSalt);
  const dekWrappedByPass = await wrapDek(kek, currentDek);
  await db.vault.update('vault', { passSalt, dekWrappedByPass });
}

export async function configureIdleTimeout(minutes: number): Promise<void> {
  idleTimeoutMs = minutes * 60_000;
  if (await db.vault.get('vault')) {
    await db.vault.update('vault', { idleTimeoutMinutes: minutes });
  }
  await db.localSettings.update('local', { paranoidIdleTimeoutMinutes: minutes });
  resetIdleTimer();
}

function purgeLocalBackups(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('gtd25-local-backup-')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

// Test-only: reset in-memory state without touching persistence.
export function __resetVaultStateForTests(): void {
  currentDek = null;
  currentSecrets = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  idleTimeoutMs = DEFAULT_IDLE_MINUTES * 60_000;
  emit();
}

// Test-only: shrink the idle window (and re-arm) so re-lock can be tested with
// real timers and a short wait.
export function __setIdleTimeoutMsForTests(ms: number): void {
  idleTimeoutMs = ms;
  resetIdleTimer();
}
