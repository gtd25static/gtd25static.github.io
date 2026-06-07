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
  generateSalt, createVerifier, checkVerifier,
  encryptBlob, decryptBlob, clearEncryptionKey,
} from '../sync/crypto';
import { deriveVaultKek, DEFAULT_ARGON2, LEGACY_KDF, type KdfParams } from './vault-kdf';
import { generateDek, wrapDek, unwrapDek, importKekFromBytes } from './vault-crypto';
import { setVaultKeyProvider } from './vault-middleware';
import { encryptAllAtRest, decryptAllAtRest } from './vault-migration';
import { registerPrfCredential, getPrfOutput } from '../sync/webauthn-prf';
import { b64encode, b64decode } from '../sync/remote-unlock-crypto';
import { PARANOID_FLAG, isParanoidFlagSet } from './paranoid-flag';
import type { Vault, PrfCredential } from './models';

// Synchronous mirror of "a security-key credential is enrolled", so the lock
// screen and settings can render the affordance without awaiting IndexedDB.
const KEY_FLAG = 'gtd25-paranoid-key';
export const DEFAULT_IDLE_MINUTES = 15;
export const DEFAULT_MAX_ATTEMPTS = 10;

export interface VaultSecrets {
  githubPat?: string;
  syncPassword?: string;
}

// --- In-memory state (never persisted) ---
let currentDek: CryptoKey | null = null;
let currentSecrets: VaultSecrets | null = null;
let idleTimeoutMs = DEFAULT_IDLE_MINUTES * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// KDF used when (re)wrapping the DEK under the passphrase; persisted per-vault.
let kdfParams: KdfParams = DEFAULT_ARGON2;

// --- Reactive snapshot for React (useSyncExternalStore) ---
export interface VaultSnapshot { enabled: boolean; unlocked: boolean; hasSecurityKey: boolean }
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
function readKeyFlag(): boolean {
  try { return localStorage.getItem(KEY_FLAG) === '1'; } catch { return false; }
}
function setKeyFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY_FLAG, '1');
    else localStorage.removeItem(KEY_FLAG);
  } catch { /* ignore */ }
}
function computeSnapshot(): VaultSnapshot {
  return { enabled: readFlag(), unlocked: currentDek !== null, hasSecurityKey: readKeyFlag() };
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

// Normalize the enrolled security keys to the array form, synthesizing a single
// entry from the legacy (pre-multi-key) `webauthnCredentialId`/`dekWrappedByPrf`
// fields when present. This is the one source of truth for "which keys unlock".
function vaultSecurityKeys(vault: Vault): PrfCredential[] {
  if (vault.securityKeys && vault.securityKeys.length > 0) return vault.securityKeys;
  if (vault.webauthnCredentialId && vault.dekWrappedByPrf) {
    return [{
      credentialId: vault.webauthnCredentialId,
      dekWrappedByPrf: vault.dekWrappedByPrf,
      label: 'Security key',
      addedAt: 0,
    }];
  }
  return [];
}

/** Persist the security-key list, clearing the legacy single-credential fields. */
async function writeSecurityKeys(keys: PrfCredential[]): Promise<void> {
  await db.vault.update('vault', {
    securityKeys: keys,
    dekWrappedByPrf: undefined,
    webauthnCredentialId: undefined,
  });
  setKeyFlag(keys.length > 0);
}

/** Enrolled security keys (metadata only) for the settings UI. */
export async function listSecurityKeys(): Promise<Array<{ credentialId: string; label?: string; addedAt: number }>> {
  const vault = await db.vault.get('vault');
  if (!vault) return [];
  return vaultSecurityKeys(vault).map(({ credentialId, label, addedAt }) => ({ credentialId, label, addedAt }));
}

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
  const kek = await deriveVaultKek(passphrase, passSalt, kdfParams);
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
    kdf: kdfParams,
    prfSalt,
    verifier,
    idleTimeoutMinutes: idleMinutes,
    maxUnlockAttempts: DEFAULT_MAX_ATTEMPTS,
    failedUnlockAttempts: 0,
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
    paranoidMaxUnlockAttempts: DEFAULT_MAX_ATTEMPTS,
    githubPat: undefined,
    encryptionPassword: undefined,
    // A Paranoid device must NOT be a remote-unlock approver — drop any approver
    // secrets it held (enforcement, alongside the runtime refusals in remote-unlock).
    remoteApproverFor: undefined,
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
  setKeyFlag(false);
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

  const kek = await deriveVaultKek(passphrase, vault.passSalt, vault.kdf ?? LEGACY_KDF);
  let dek: CryptoKey | null = null;
  try {
    dek = await unwrapDek(kek, vault.dekWrappedByPass);
  } catch { /* wrong passphrase -> AES-GCM auth failure */ }

  const ok = dek ? await finishUnlock(vault, dek) : false;
  if (!ok) {
    await registerFailedAttempt(vault);
    return false;
  }
  // Transparently upgrade a legacy PBKDF2 vault to Argon2id now that we hold the
  // passphrase (rewrapPassphrase no-ops if a resumed disable tore the vault down).
  if ((vault.kdf?.algo ?? 'pbkdf2') !== DEFAULT_ARGON2.algo) {
    await rewrapPassphrase(passphrase);
  }
  return true;
}

// Count a failed passphrase unlock; trip the panic wipe at the configured limit.
// The counter lives in the vault row so a reload cannot reset it.
async function registerFailedAttempt(vault: Vault): Promise<void> {
  const max = vault.maxUnlockAttempts ?? 0; // 0 => tripwire disabled
  const count = (vault.failedUnlockAttempts ?? 0) + 1;
  await db.vault.update('vault', { failedUnlockAttempts: count });
  if (max > 0 && count >= max) {
    const { panicWipe } = await import('../lib/panic-wipe'); // dynamic: avoids an import cycle
    await panicWipe();
  }
}

/**
 * Unlock via a registered FIDO2 security key (PRF). Returns false when no key is
 * enrolled, the user cancels, or the derived key is wrong — the caller then falls
 * back to the passphrase.
 */
export async function unlockWithSecurityKey(): Promise<boolean> {
  const vault = await db.vault.get('vault');
  if (!vault?.prfSalt) return false;
  const keys = vaultSecurityKeys(vault);
  if (keys.length === 0) return false;

  // Allow any enrolled key; the responding authenticator (plugged YubiKey or a
  // phone over hybrid) yields its own PRF output. We don't know which one it was,
  // so derive the KEK and try to unwrap each enrolled DEK — only the matching
  // credential's wrap succeeds.
  const prfOutput = await getPrfOutput(
    keys.map((k) => k.credentialId),
    vault.prfSalt,
    keys.map((k) => k.transports),
  );
  if (!prfOutput) return false;

  const kek = await importKekFromBytes(prfOutput);
  for (const k of keys) {
    try {
      const dek = await unwrapDek(kek, k.dekWrappedByPrf);
      return await finishUnlock(vault, dek);
    } catch { /* not this credential — try the next */ }
  }
  return false; // PRF output didn't reconstruct any enrolled KEK
}

// Shared tail of every unlock path: verify the DEK, hydrate in-memory state,
// resume any interrupted migration, and notify subscribers.
async function finishUnlock(vault: Vault, dek: CryptoKey): Promise<boolean> {
  if (!(await checkVerifier(dek, vault.verifier))) return false;

  currentDek = dek;
  // A successful unlock (passphrase OR security key) clears the failure tripwire.
  if ((vault.failedUnlockAttempts ?? 0) !== 0) {
    await db.vault.update('vault', { failedUnlockAttempts: 0 });
  }
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
 * Enroll a FIDO2 security key as a second way to unlock: wrap the live DEK with a
 * KEK derived from the key's PRF (hmac-secret) output. Requires the vault to be
 * unlocked. Throws (with a specific reason) on cancel / unsupported PRF.
 */
export async function addSecurityKey(label?: string): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before adding a security key');
  const vault = await db.vault.get('vault');
  if (!vault) throw new Error('Vault not found');

  // All credentials share the vault's single PRF salt (per-credential PRF output
  // is still unique). Reuse the existing one so already-enrolled keys keep working.
  const prfSalt = vault.prfSalt ?? generateSalt();
  // Throws on cancel / unsupported PRF / empty result — the caller surfaces why.
  // 'cross-platform' lets the OS offer a plugged FIDO2 key OR "use a phone"
  // (hybrid transport), which routes to a phone's PRF.
  const reg = await registerPrfCredential(prfSalt, 'cross-platform');

  const kek = await importKekFromBytes(reg.prfOutput);
  const entry: PrfCredential = {
    credentialId: reg.credentialId,
    dekWrappedByPrf: await wrapDek(kek, currentDek),
    label: label?.trim() || undefined,
    addedAt: Date.now(),
    transports: reg.transports,
  };
  // Append, replacing any existing entry for the same credential (re-enroll).
  const keys = vaultSecurityKeys(vault).filter((k) => k.credentialId !== entry.credentialId);
  keys.push(entry);

  if (!vault.prfSalt) await db.vault.update('vault', { prfSalt });
  await writeSecurityKeys(keys);
  emit();
}

/**
 * Remove an enrolled security key by credential id (or, with no argument, all of
 * them). The passphrase always remains an unlock method, so removing every key
 * is safe.
 */
export async function removeSecurityKey(credentialId?: string): Promise<void> {
  const vault = await db.vault.get('vault');
  if (!vault) return;
  const remaining = credentialId
    ? vaultSecurityKeys(vault).filter((k) => k.credentialId !== credentialId)
    : [];
  await writeSecurityKeys(remaining);
  emit();
}

// --- Remote unlock (DEK wrapped by a remote-unlock key held by trusted devices) ---

/** Wrap the live DEK with a 32-byte RUK and persist it (both directions, so the RUK
 *  can be recovered while unlocked to add more approvers). Requires the vault unlocked. */
export async function wrapDekWithRuk(rukRaw: Uint8Array): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before enrolling remote unlock');
  const kek = await importKekFromBytes(rukRaw);
  const dekWrappedByRuk = await wrapDek(kek, currentDek);
  const rukWrappedByDek = await encryptBlob(currentDek, b64encode(rukRaw));
  await db.vault.update('vault', { dekWrappedByRuk, rukWrappedByDek });
}

/** Recover the raw RUK (requires the vault unlocked + remote unlock enrolled), or null. */
export async function getRukRaw(): Promise<Uint8Array | null> {
  if (!currentDek) return null;
  const vault = await db.vault.get('vault');
  if (!vault?.rukWrappedByDek) return null;
  return b64decode(await decryptBlob(currentDek, vault.rukWrappedByDek));
}

/** Unlock using a remote-unlock key (RUK) relayed from a trusted device. */
export async function unlockWithRemoteKey(rukRaw: Uint8Array): Promise<boolean> {
  const vault = await db.vault.get('vault');
  if (!vault?.dekWrappedByRuk) return false;
  const kek = await importKekFromBytes(rukRaw);
  let dek: CryptoKey;
  try {
    dek = await unwrapDek(kek, vault.dekWrappedByRuk);
  } catch {
    return false; // wrong RUK
  }
  return finishUnlock(vault, dek);
}

/** True once remote unlock is enrolled on this device (a wrapped-by-RUK DEK exists). */
export async function isRemoteUnlockEnrolled(): Promise<boolean> {
  const vault = await db.vault.get('vault');
  return !!vault?.dekWrappedByRuk;
}

/** Tear down remote-unlock enrollment (drop the RUK-wrapped DEK + cached approvers). */
export async function clearRemoteUnlock(): Promise<void> {
  await db.vault.update('vault', { dekWrappedByRuk: undefined, rukWrappedByDek: undefined, remoteUnlock: undefined });
}

/** Re-wrap the DEK under a (possibly new) passphrase with the current KDF. */
async function rewrapPassphrase(passphrase: string): Promise<void> {
  if (!currentDek) return;
  if (!(await db.vault.get('vault'))) return;
  const passSalt = generateSalt();
  const kek = await deriveVaultKek(passphrase, passSalt, kdfParams);
  const dekWrappedByPass = await wrapDek(kek, currentDek);
  await db.vault.update('vault', { passSalt, dekWrappedByPass, kdf: kdfParams });
}

/** Re-wrap the DEK under a new passphrase. Requires the vault to be unlocked. */
export async function changePassphrase(newPassphrase: string): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before changing the passphrase');
  if (!newPassphrase) throw new Error('A passphrase is required');
  await rewrapPassphrase(newPassphrase);
}

export async function configureIdleTimeout(minutes: number): Promise<void> {
  idleTimeoutMs = minutes * 60_000;
  if (await db.vault.get('vault')) {
    await db.vault.update('vault', { idleTimeoutMinutes: minutes });
  }
  await db.localSettings.update('local', { paranoidIdleTimeoutMinutes: minutes });
  resetIdleTimer();
}

/**
 * Read every encrypted row and count how many could not be decrypted (they come
 * back quarantined with `_decryptError`). Lets the user confirm their local data
 * is intact and recoverable. Requires the vault to be unlocked.
 */
export async function verifyAtRestIntegrity(): Promise<{ total: number; unreadable: number }> {
  if (!currentDek) throw new Error('Unlock the vault before verifying integrity');
  const [lists, tasks, subtasks] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.toArray(),
    db.subtasks.toArray(),
  ]);
  const all = [...lists, ...tasks, ...subtasks] as Array<{ _decryptError?: boolean }>;
  const unreadable = all.filter((r) => r._decryptError === true).length;
  return { total: all.length, unreadable };
}

/** Set the failed-attempt wipe threshold (0 disables it). */
export async function configureMaxUnlockAttempts(n: number): Promise<void> {
  const max = Math.max(0, Math.floor(n));
  if (await db.vault.get('vault')) {
    await db.vault.update('vault', { maxUnlockAttempts: max });
  }
  await db.localSettings.update('local', { paranoidMaxUnlockAttempts: max });
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

// Test-only: use light KDF params so enable/unlock stay fast in the suite while
// still exercising the real Argon2id code path.
export function __setKdfParamsForTests(p: KdfParams): void {
  kdfParams = p;
}
