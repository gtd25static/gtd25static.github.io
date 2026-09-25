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
import { generateDek, wrapDek, unwrapDek, importKekFromBytes, generateGarbageSlot, isLegacyWrap } from './vault-crypto';
import { setVaultKeyProvider } from './vault-middleware';
import { encryptAllAtRest, decryptAllAtRest } from './vault-migration';
import { withSyncLock } from '../sync/sync-lock';
import { registerPrfCredential, getPrfOutput } from '../sync/webauthn-prf';
import { b64encode, b64decode } from '../sync/remote-unlock-crypto';
import { PARANOID_FLAG, isParanoidFlagSet } from './paranoid-flag';
import { recordError } from '../lib/diagnostics';
import { recordUnlockAttempt, type UnlockMethod } from '../lib/unlock-audit';
import { pruneHistory } from '../lib/relaxed-unlock';
import { checkSecretStrength } from '../lib/password-strength';
import { reinitVaultWithPlaceholders } from './vault-reinit';
import { rekeyVaultContent, type RekeyResult } from './vault-rekey';
import { DEFAULT_MAX_ATTEMPTS } from '../lib/constants';
import { purgeLocalBackups, decryptLocalBackups, createLocalBackup } from './backup';
import { onTabSignal, signalOtherTabs } from '../lib/tab-channel';
import type { LocalSettings, Vault, PrfCredential } from './models';

// Synchronous mirror of "a security-key credential is enrolled", so the lock
// screen and settings can render the affordance without awaiting IndexedDB.
const KEY_FLAG = 'gtd25-paranoid-key';
export const DEFAULT_IDLE_MINUTES = 15;
export { DEFAULT_MAX_ATTEMPTS };   // re-exported: the value lives in lib/constants

export interface VaultSecrets {
  githubPat?: string;
  syncPassword?: string;
}
export type { RekeyResult };

// --- In-memory state (never persisted) ---
let currentDek: CryptoKey | null = null;
let currentSecrets: VaultSecrets | null = null;
let idleTimeoutMs = DEFAULT_IDLE_MINUTES * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// KDF used when (re)wrapping the DEK under the passphrase; persisted per-vault.
let kdfParams: KdfParams = DEFAULT_ARGON2;
// True only while the vault is being rewritten under another key (a secondary
// unlock's re-init, or a re-key). Both read the content through currentDek, so a
// lock landing in that window — another tab's idle lock or hotkey — would null
// the key halfway through the read. Such a signal is not for this tab: at a
// secondary unlock it is still at its lock screen, and a re-key shows nothing.
let rekeying = false;
// A lock asked for while `rekeying` (idle timer, hotkey, another tab): it can't
// drop the key mid-swap, so it runs as soon as the swap ends. It used to be
// dropped altogether, leaving the vault unlocked after a lock was asked for.
let lockDeferredByRekey = false;

// --- Reactive snapshot for React (useSyncExternalStore) ---
// `busy`: the vault is being rewritten under another key; the app must not
// render its content meanwhile (see rekeyVault).
export interface VaultSnapshot { enabled: boolean; unlocked: boolean; hasSecurityKey: boolean; busy: boolean }
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
  return { enabled: readFlag(), unlocked: currentDek !== null, hasSecurityKey: readKeyFlag(), busy: rekeying };
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

async function patchLocalSettings(updates: Partial<LocalSettings>): Promise<void> {
  const existing = await db.localSettings.get('local');
  await db.localSettings.put({
    id: 'local',
    syncEnabled: false,
    syncIntervalMs: 300_000,
    ...existing,
    ...updates,
  });
}

// Feed the at-rest key to the DBCore middleware. DEK access is NOT user activity:
// background reads (recurring-task checks, liveQuery refreshes, sync) must not defer
// the idle re-lock, or the vault could stay unlocked indefinitely on an idle device
// while the tab is open (ACR-002). Only real interaction — via touchVaultActivity()
// from App.tsx pointer/key handlers — re-arms the idle timer.
setVaultKeyProvider(() => currentDek);

// --- Idle re-lock ---
let lastActivityAt = Date.now();
function resetIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  lastActivityAt = Date.now();
  if (currentDek) idleTimer = setTimeout(() => { lock(); }, idleTimeoutMs);
}
/** Call on user interaction to defer the idle re-lock. */
export function touchVaultActivity(): void { resetIdleTimer(); }

/**
 * Read-only view of the idle countdown, for the privacy overlay: when the
 * last re-arming interaction happened and the *effective* window (relaxed
 * unlock adjusts it at runtime). Reading this never defers the re-lock.
 */
export function getVaultIdleState(): { lastActivityAt: number; timeoutMs: number } {
  return { lastActivityAt, timeoutMs: idleTimeoutMs };
}

// "Relaxed unlock" adjusts the idle window live. It sets the value WITHOUT
// re-arming: the next touchVaultActivity() re-arms with it. Re-arming here (e.g. on
// the engine's periodic tick) would restart the idle countdown and could keep the
// vault unlocked indefinitely. Distinct from configureIdleTimeout (persists the base).
export function setRuntimeIdleTimeoutMs(ms: number): void {
  idleTimeoutMs = Math.max(60_000, ms);
}

// Record a successful unlock for the Relaxed-unlock multiplier (device-local,
// pruned to 36h, never synced). No-op unless the feature is enabled, and
// best-effort — a telemetry write must never break the unlock.
async function recordUnlockEvent(): Promise<void> {
  const local = await db.localSettings.get('local');
  if (!local?.relaxedUnlockEnabled) return;
  const now = Date.now();
  const history = pruneHistory([...(local.unlockHistory ?? []), now], now);
  await db.localSettings.update('local', { unlockHistory: history });
}

// DEK access only — does NOT count as user activity (see the key-provider note
// above); the idle timer is re-armed solely by touchVaultActivity() / unlock / config.
export function getDEK(): CryptoKey | null { return currentDek; }
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

/**
 * Reconcile the synchronous `hasSecurityKey` flag (a localStorage cache the lock
 * screen reads on first paint) against the authoritative vault metadata, and emit if
 * it changed. The flag is only a cache — clearing/tampering with localStorage must not
 * hide an enrolled key — so the lock screen calls this on mount to self-heal it from
 * the persisted vault row (ACR-012). Returns the metadata-derived truth.
 */
export async function refreshSecurityKeyFlag(): Promise<boolean> {
  const vault = await db.vault.get('vault');
  const has = vault ? vaultSecurityKeys(vault).length > 0 : false;
  if (has !== readKeyFlag()) { setKeyFlag(has); emit(); }
  return has;
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

/** Drop the keys held by THIS tab. */
function lockThisTab(): void {
  if (rekeying) { lockDeferredByRekey = true; return; }
  currentDek = null;
  currentSecrets = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clearEncryptionKey(); // drop the sync key too
  emit();
}

/** End of a re-key window: honour a lock that arrived during it. */
function endRekeyWindow(): void {
  rekeying = false;
  if (!lockDeferredByRekey) return;
  lockDeferredByRekey = false;
  lockThisTab();
}

export function lock(): void {
  lockThisTab();
  // Locking is app-wide: the idle timer, the hotkey and lock-when-hidden all run
  // per tab, so without this a forgotten second tab would stay unlocked and
  // readable while you thought you had locked up. Only the lock travels — an
  // unlock never does; see lib/tab-channel.
  signalOtherTabs({ type: 'lock' });
}

/**
 * Follow lock/wipe signals from the app's other tabs. Called once at startup.
 * Handled here rather than at module scope so importing the vault never opens a
 * channel on its own. Returns an unsubscribe.
 */
export function startCrossTabLock(): () => void {
  return onTabSignal(() => lockThisTab()); // both signals mean: drop the keys here
}

// --- Enable / disable / unlock ---

export async function enableParanoid(passphrase: string, idleMinutes = DEFAULT_IDLE_MINUTES): Promise<void> {
  if (readFlag()) throw new Error('Paranoid mode is already enabled');
  if (!passphrase) throw new Error('A passphrase is required');
  // A vault row without the flag is an enable that never finished. Its DEK is the
  // only key to the rows it already encrypted, so minting a new vault over it
  // destroyed them. Never replace it: finishing it is reconcileParanoidFlag's and
  // the next unlock's job.
  if (await db.vault.get('vault')) {
    throw new Error('An earlier Paranoid Mode setup is unfinished. Reload the app and unlock with the passphrase you chose then to complete it.');
  }

  const dek = await generateDek();
  const passSalt = generateSalt();
  const kek = await deriveVaultKek(passphrase, passSalt, kdfParams);
  const dekWrappedByPass = await wrapDek(kek, dek, 'slot1');
  const wrappedDek2 = await generateGarbageSlot(); // uniform slot 2 (no duress yet)
  const verifier = await createVerifier(dek);
  const prfSalt = generateSalt();

  // Snapshot current sync credentials into the vault (encrypted with the DEK) up
  // front, so an enable resumed after a crash still has them.
  const local = await db.localSettings.get('local');
  const secrets: VaultSecrets = { githubPat: local?.githubPat, syncPassword: local?.encryptionPassword };

  await db.vault.put({
    id: 'vault',
    dekWrappedByPass,
    wrappedDek2,
    passSalt,
    kdf: kdfParams,
    prfSalt,
    verifier,
    secrets: await encryptBlob(dek, JSON.stringify(secrets)),
    idleTimeoutMinutes: idleMinutes,
    maxUnlockAttempts: DEFAULT_MAX_ATTEMPTS,
    failedUnlockAttempts: 0,
    migrationState: 'encrypting',
  });

  // Activate the DEK so the migration encrypts as it rewrites, then raise the
  // flag BEFORE touching any row: from here on the device is Paranoid, so a crash
  // brings it back to the lock screen and the next unlock resumes the enable.
  // (Raised last, as it used to be, a crash mid-migration left a device that
  // looked un-Paranoid over rows it could no longer read.)
  currentDek = dek;
  currentSecrets = secrets;
  idleTimeoutMs = idleMinutes * 60_000;
  setFlag(true);
  // The app's other tabs hold no key: they would go on reading the rows as they
  // are rewritten below and get ciphertext back (which crashed them). Reload them
  // now that the flag is up, so they come back at the lock screen.
  signalOtherTabs({ type: 'reload' });

  try {
    await completeEnable();
  } catch (err) {
    recordError('vault.enable', err);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Encryption didn't finish (${reason}). It resumes the next time you unlock.`);
  } finally {
    resetIdleTimer();
    emit();
  }
}

/**
 * Everything an enable does once the vault exists — idempotent, so an
 * interrupted enable resumes it at the next unlock (finishUnlock). Encrypt every
 * row; strip the plaintext credentials (already in vault.secrets) from
 * localSettings, which the at-rest middleware doesn't cover; and only then drop
 * the plaintext safety backups, so they stay a recovery point until every row
 * has been rewritten.
 */
async function completeEnable(): Promise<void> {
  // Holding the sync lock: a sync applying remote rows between the migration's
  // read and write would have them overwritten by its stale copies.
  await withSyncLock(() => encryptAllAtRest());
  await db.vault.update('vault', { migrationState: 'done' });
  const vault = await db.vault.get('vault');
  await db.localSettings.update('local', {
    paranoidEnabled: true,
    paranoidIdleTimeoutMinutes: vault?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES,
    paranoidMaxUnlockAttempts: vault?.maxUnlockAttempts ?? DEFAULT_MAX_ATTEMPTS,
    githubPat: undefined,
    encryptionPassword: undefined,
    // A Paranoid device must NOT be a remote-unlock approver — drop any approver
    // secrets it held (enforcement, alongside the runtime refusals in remote-unlock).
    remoteApproverFor: undefined,
  });
  purgeLocalBackups();
}

/**
 * Boot-time repair of the two halves of "this device is Paranoid", which live in
 * different stores — the flag in localStorage, the vault in IndexedDB — and so
 * can't be written atomically. The vault is the authority (it holds the only key
 * to the encrypted rows):
 *  - vault but no flag: an enable died right after saving the vault. Raise the
 *    flag so the lock screen appears; the unlock resumes the enable.
 *  - flag but no vault: a disable died right after deleting the vault (the rows
 *    are already plaintext). Drop the flag, or the lock screen would ask forever
 *    for a passphrase no vault can check.
 * main.tsx runs it before the first render. Never throws.
 */
export async function reconcileParanoidFlag(): Promise<void> {
  try {
    const hasVault = !!(await db.vault.get('vault'));
    if (hasVault === readFlag()) return;
    setFlag(hasVault);
    if (!hasVault) setKeyFlag(false);
    emit();
  } catch (err) {
    recordError('vault.reconcileFlag', err);
  }
}

export async function disableParanoid(): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before disabling Paranoid Mode');
  await db.vault.update('vault', { migrationState: 'decrypting' });
  await completeDisable();
}

async function completeDisable(): Promise<void> {
  const dek = currentDek;
  if (!dek) throw new Error('Unlock the vault before disabling Paranoid Mode');
  // Every other unlocked tab holds this key and would go on encrypting rows under
  // it (a focus refill is enough) — rows nothing can open once the vault below
  // is deleted. Lock them before the first row is touched; they reload at the end.
  signalOtherTabs({ type: 'lock' });
  await withSyncLock(() => decryptAllAtRest(dek)); // see completeEnable
  // The safety backups too, while the key that opens them still exists.
  await decryptLocalBackups();
  // Restore the plaintext credentials to localSettings so non-paranoid sync works.
  const restored = currentSecrets;
  await db.localSettings.update('local', {
    paranoidEnabled: false,
    githubPat: restored?.githubPat,
    encryptionPassword: restored?.syncPassword,
  });
  // Lower the flag BEFORE the vault goes, then decrypt once more. Without the
  // flag no tab has an at-rest key (vault-middleware), so nothing is encrypted
  // from here on, and this last pass picks up whatever a background write here —
  // or a tab that missed the lock — encrypted into a table the first pass had
  // already done. A crash in between leaves vault-without-flag, which the boot
  // reconcile turns back into a lock screen whose unlock resumes the disable.
  setFlag(false);
  try {
    await withSyncLock(() => decryptAllAtRest(dek));
    await db.vault.delete('vault'); // delete LAST so an interrupted disable can resume
  } catch (err) {
    setFlag(true); // the vault is still there: still Paranoid until it resumes
    throw err;
  }
  setKeyFlag(false);
  currentDek = null;
  currentSecrets = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clearEncryptionKey();
  emit();
  // The other tabs locked above, but still hold in memory what they showed.
  signalOtherTabs({ type: 'reload' });
}

// Why the most recent unlock attempt failed. 'wrong-credential' is the only
// reason that burns a failed attempt: 'corrupt-vault' and 'resume-failed' occur
// AFTER the verifier proved the credential right, so counting them could march
// a correct passphrase into the failed-attempt wipe.
export type UnlockFailureReason = 'wrong-credential' | 'corrupt-vault' | 'resume-failed';
let lastUnlockFailure: UnlockFailureReason | null = null;

/** Reason the most recent unlock attempt failed (null after a success). */
export function getLastUnlockFailure(): UnlockFailureReason | null {
  return lastUnlockFailure;
}

// Serialize unlock attempts so concurrent wrong guesses cannot interleave their
// read-modify-write of failedUnlockAttempts and collapse to a single increment,
// which would let an attacker exceed the wipe threshold undetected (ACR-009).
let unlockChain: Promise<unknown> = Promise.resolve();
function serializeUnlock<T>(fn: () => Promise<T>): Promise<T> {
  const run = unlockChain.then(fn, fn);
  unlockChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Returns false on a wrong passphrase; true once unlocked. */
export function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  return serializeUnlock(() => doUnlockWithPassphrase(passphrase));
}

// A passphrase is stored trimmed — enable and every change of passphrase have
// trimmed it since the first version — but was compared exactly as typed back:
// a trailing space (phone keyboards add one) read "Incorrect passphrase" and
// counted toward the attempt wipe. Every check tries it exactly as typed first,
// then trimmed if that differs, as ONE attempt. As typed first, so a passphrase
// that does carry surrounding spaces still opens exactly as before.
function passphraseCandidates(typed: string): string[] {
  const trimmed = typed.trim();
  return trimmed && trimmed !== typed ? [typed, trimmed] : [typed];
}

interface PassphraseMatch { slot: 'slot1' | 'slot2'; kek: CryptoKey; dek: CryptoKey; passphrase: string }

/**
 * Which passphrase slot `typed` opens, in the lock screen's order: for each of
 * its candidates (above), slot 1 and then slot 2 — the same work whether or not
 * slot 2 holds a secondary passphrase. Null when neither opens. With
 * `errorLabel`, a failure to derive the key is recorded under it and rethrown
 * as a message the settings toast can show as-is. Pure: no write, no count.
 */
async function openPassphraseSlot(vault: Vault, typed: string, errorLabel?: string): Promise<PassphraseMatch | null> {
  for (const passphrase of passphraseCandidates(typed)) {
    let kek: CryptoKey;
    try {
      kek = await deriveVaultKek(passphrase, vault.passSalt, vault.kdf ?? LEGACY_KDF);
    } catch (err) {
      if (!errorLabel) throw err;
      // E.g. WebAssembly (Argon2id) unavailable. Record the real cause for
      // diagnostics; surface a message the settings toast can show as-is.
      recordError(errorLabel, err);
      throw new Error('Could not derive the key on this device — make sure the app is up to date and try again');
    }
    const slot1 = await unwrapDek(kek, vault.dekWrappedByPass, 'slot1').catch(() => null);
    if (slot1) return { slot: 'slot1', kek, dek: slot1, passphrase };
    const slot2 = vault.wrappedDek2 ? await unwrapDek(kek, vault.wrappedDek2, 'slot2').catch(() => null) : null;
    if (slot2) return { slot: 'slot2', kek, dek: slot2, passphrase };
  }
  return null;
}

async function doUnlockWithPassphrase(typed: string): Promise<boolean> {
  const vault = await db.vault.get('vault');
  if (!vault) return false;
  lastUnlockFailure = null;

  const match = await openPassphraseSlot(vault, typed);
  if (!match) {
    lastUnlockFailure = 'wrong-credential';
    await registerFailedAttempt();
    return false;
  }
  // Slot 2: the duress passphrase. Unwraps the real DEK, then re-keys the vault
  // to decoy content and finishes as a completely normal 'passphrase' unlock.
  if (match.slot === 'slot2') return applySecondaryUnlock(vault, match.dek, match.kek);

  // The passphrase that opened slot 1 — what a re-wrap below must use, not the
  // stray whitespace around it.
  const { kek, dek, passphrase } = match;
  if (!(await finishUnlock(vault, dek, 'passphrase'))) {
    // Only a wrong credential counts toward the wipe tripwire (see UnlockFailureReason).
    if (lastUnlockFailure === 'wrong-credential') await registerFailedAttempt();
    return false;
  }
  // Transparently upgrade a legacy PBKDF2 vault to Argon2id now that we hold the
  // passphrase (rewrapPassphrase no-ops if a resumed disable tore the vault down).
  // Opportunistic hardening only: a failed re-wrap (WASM blocked by CSP, Argon2's
  // 64 MiB refused, …) must never turn an already-successful unlock into an error.
  if ((vault.kdf?.algo ?? 'pbkdf2') !== DEFAULT_ARGON2.algo) {
    try {
      await rewrapPassphrase(passphrase);
    } catch (err) {
      recordError('vault.kdfUpgrade', err);
    }
  } else if (isLegacyWrap(vault.dekWrappedByPass)) {
    // Same spirit: a slot-1 wrap from before slot binding is rewritten bound now
    // that its KEK is in hand (the KDF upgrade above rewrites it bound anyway).
    try {
      await db.vault.update('vault', { dekWrappedByPass: await wrapDek(kek, dek, 'slot1') });
    } catch (err) {
      recordError('vault.slotBind', err);
    }
  }
  return true;
}

// The duress path: real DEK just unwrapped from slot 2. Re-key the vault to
// decoy content (destroying every trace of the real content that a fresh DEK
// can't read), then finish as an ordinary passphrase unlock so the coercer sees
// nothing unusual. Any failure here must NOT reveal the duress path — it falls
// back to a normal 'wrong credential', because the re-key is atomic (rolled back
// on error) and the real passphrase still works afterwards.
async function applySecondaryUnlock(vault: Vault, realDek: CryptoKey, secondaryKek: CryptoKey): Promise<boolean> {
  // Another tab may be open and unlocked with the real key: it would keep showing
  // the real content and write rows under a key about to stop existing. Lock it
  // first. (A normal unlock sends nothing — only this path makes their key stale.)
  signalOtherTabs({ type: 'lock' });
  rekeying = true;
  try {
    currentDek = realDek; // make the real DEK the middleware read-key for the re-key
    const newDek = await reinitVaultWithPlaceholders(vault, realDek, secondaryKek);
    currentDek = null;
    rekeying = false; // from here on, locks behave as during any other unlock
    const lockAskedMeanwhile = lockDeferredByRekey;
    lockDeferredByRekey = false;
    // The other tabs locked before the re-key, but their memory still holds what
    // they showed and fetched under the real key. Reload them now that the swap is
    // on disk, so they come back up knowing only the placeholder vault.
    signalOtherTabs({ type: 'reload' });
    setKeyFlag(false); // PRF security keys were dropped in the re-key
    const rekeyed = await db.vault.get('vault');
    if (!rekeyed) { lastUnlockFailure = 'corrupt-vault'; return false; }
    const unlocked = await finishUnlock(rekeyed, newDek, 'passphrase');
    if (unlocked && lockAskedMeanwhile) lockThisTab();
    return unlocked;
  } catch (err) {
    // Roll back any in-memory key; the transaction already rolled back on disk.
    currentDek = null;
    // A neutral label: the diagnostics log is readable from Settings, and this
    // failure must read like any other unlock problem.
    recordError('vault.unlock', err);
    lastUnlockFailure = 'wrong-credential';
    return false;
  } finally {
    rekeying = false;
    lockDeferredByRekey = false; // a failed unlock leaves the vault locked anyway
  }
}

/**
 * Configure (or replace) the duress passphrase. Requires the vault unlocked.
 * Slot 2 will wrap the REAL DEK under this passphrase, so it must clear the same
 * strength gate as the main passphrase, and must differ from it. There is
 * deliberately NO stored flag and NO way to query whether duress is set — the
 * settings UI always offers the same "set/replace" action.
 */
export async function setSecondaryPassphrase(duressPassphrase: string): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault before setting a secondary passphrase');
  const trimmed = duressPassphrase.trim();
  if (!trimmed) throw new Error('Choose a secondary passphrase');
  const strength = checkSecretStrength(trimmed, 'vault');
  if (!strength.ok) throw new Error(strength.reason ?? 'Secondary passphrase is too weak');

  const vault = await db.vault.get('vault');
  if (!vault) throw new Error('Vault not found');
  // Slot 2 is wrapped under this vault's salt + KDF. A legacy PBKDF2 vault moves to
  // Argon2id (with a new salt) the next time the main passphrase unlocks it, which
  // would leave slot 2 unopenable — failing as a wrong passphrase exactly when used.
  if ((vault.kdf?.algo ?? 'pbkdf2') !== DEFAULT_ARGON2.algo) {
    throw new Error('Lock and unlock once with your main passphrase first, then set the secondary passphrase');
  }
  let kek: CryptoKey;
  try {
    kek = await deriveVaultKek(trimmed, vault.passSalt, vault.kdf ?? LEGACY_KDF);
  } catch (err) {
    // E.g. WebAssembly (Argon2id) unavailable. Record the real cause for
    // diagnostics; surface a message the settings toast can show as-is.
    recordError('vault.setSecondaryPassphrase', err);
    throw new Error('Could not derive the key on this device — make sure the app is up to date and try again');
  }

  // Reject a duress phrase equal to the real one: if it unwraps slot 1, it is the
  // real passphrase (we never store the real passphrase to compare directly).
  try {
    await unwrapDek(kek, vault.dekWrappedByPass, 'slot1');
    throw new Error('The secondary passphrase must be different from your main passphrase');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('The secondary')) throw e;
    /* expected: real passphrase KEK differs, so slot 1 won't unwrap */
  }

  await db.vault.update('vault', { wrappedDek2: await wrapDek(kek, currentDek, 'slot2') });
}

export type PassphraseCheck = 'main' | 'secondary' | 'none';

// Whether a candidate opens slot 1, derived exactly as the lock screen would
// (this vault's salt + KDF, as typed and then trimmed — openPassphraseSlot).
// Returns the passphrase that did, which is what a re-wrap must use. The
// secondary passphrase opens slot 2 and so reads like any wrong one. Pure read.
async function authenticateMainPassphrase(
  candidate: string,
  errorLabel: string,
): Promise<{ vault: Vault; mainPassphrase: string | null }> {
  const vault = await db.vault.get('vault');
  if (!vault) throw new Error('Vault not found');
  const match = await openPassphraseSlot(vault, candidate, errorLabel);
  return { vault, mainPassphrase: match?.slot === 'slot1' ? match.passphrase : null };
}

/**
 * Which slot a passphrase would open at the lock screen — slot 1 first, then the
 * duress slot, same derivation and the same leniency about surrounding
 * whitespace — WITHOUT unlocking with it: lets the user confirm the duress
 * passphrase works without triggering its re-key. Pure read: no write, no
 * unlock-log entry, no failed-attempt count, no tab signal. It needs the
 * passphrase itself, so it keeps the "no way to query whether duress is set"
 * property: a wrong guess reads 'none' whether or not slot 2 is in use.
 * Requires the vault unlocked, and refuses to answer if it locked mid-check (so
 * the answer can never surface on the lock screen).
 */
export async function checkPassphrase(candidate: string): Promise<PassphraseCheck> {
  if (!currentDek) throw new Error('Unlock the vault first');
  if (!candidate) return 'none'; // the lock screen ignores an empty field too
  const vault = await db.vault.get('vault');
  if (!vault) throw new Error('Vault not found');
  const match = await openPassphraseSlot(vault, candidate, 'vault.checkPassphrase');
  const result: PassphraseCheck = !match ? 'none' : match.slot === 'slot1' ? 'main' : 'secondary';
  if (!currentDek) throw new Error('Unlock the vault first');
  return result;
}

/**
 * Whether `candidate` is this vault's main passphrase: the gate in front of the
 * actions that change how the vault opens (new passphrase, security keys,
 * secondary passphrase, approvers, the attempt limit, disabling), so an unlocked
 * but unattended session cannot be used to add a way in. Only slot 1 counts — the
 * secondary passphrase is refused like any other wrong one, and reads the same.
 * Pure read (no write, no failed-attempt count, no unlock-log entry, no tab
 * signal); requires the vault unlocked and refuses to answer if it locked
 * mid-check.
 */
export async function confirmCurrentPassphrase(candidate: string): Promise<boolean> {
  if (!currentDek) throw new Error('Unlock the vault first');
  if (!candidate) return false;
  const { mainPassphrase } = await authenticateMainPassphrase(candidate, 'vault.confirmPassphrase');
  if (!currentDek) throw new Error('Unlock the vault first');
  return mainPassphrase !== null;
}

/** Remove any duress passphrase by re-randomising slot 2. Requires unlock. */
export async function clearSecondaryPassphrase(): Promise<void> {
  if (!currentDek) throw new Error('Unlock the vault first');
  await db.vault.update('vault', { wrappedDek2: await generateGarbageSlot() });
}

// Count a failed unlock; trip the panic wipe at the configured limit. The counter
// lives in the vault row so a reload cannot reset it. Re-reads the LATEST
// persisted vault (not a possibly-stale snapshot) so the increment is monotonic
// under serialized attempts (ACR-009).
//
// `countsTowardWipe` is false for the remote path on purpose: a remote attempt is
// driven by whoever can write the repo, so counting it would hand a PAT holder a
// way to wipe the device from a distance. It is still logged — the audit trail is
// the point, and a failure there is exactly what you want to see afterwards.
async function registerFailedAttempt(method: UnlockMethod = 'passphrase', countsTowardWipe = true): Promise<void> {
  await recordUnlockAttempt(method, false, Date.now());
  if (!countsTowardWipe) return;
  const vault = await db.vault.get('vault');
  if (!vault) return;
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
  lastUnlockFailure = null;
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
    let dek: CryptoKey;
    try {
      dek = await unwrapDek(kek, k.dekWrappedByPrf, `prf:${k.credentialId}`);
    } catch { continue; /* not this credential — try the next */ }
    const ok = await finishUnlock(vault, dek, 'securityKey');
    if (ok && isLegacyWrap(k.dekWrappedByPrf)) {
      // Rewrite a wrap from before slot binding bound to its credential, now that
      // its KEK is in hand. Opportunistic: never fails the unlock.
      try {
        const bound = await wrapDek(kek, dek, `prf:${k.credentialId}`);
        await writeSecurityKeys(keys.map((e) => (e === k ? { ...e, dekWrappedByPrf: bound } : e)));
      } catch (err) {
        recordError('vault.slotBind', err);
      }
    }
    return ok;
  }
  // An authenticator answered but reconstructed no enrolled wrap. Logged, so the
  // audit trail is tamper-evident for this method too — but NOT counted toward
  // the wipe, for the same reason as the remote path: we cannot tell "someone
  // presented a key that is not enrolled" from "an enrolled credential returned
  // a different PRF output", which is what a reset authenticator or a synced
  // passkey evaluated on another device does. Counting it would let a flaky key
  // destroy the database in ten presses of a button that invites retrying.
  lastUnlockFailure = 'wrong-credential';
  await registerFailedAttempt('securityKey', false);
  return false; // PRF output didn't reconstruct any enrolled KEK
}

// Shared tail of every unlock path: verify the DEK, hydrate in-memory state,
// resume any interrupted migration, and notify subscribers.
async function finishUnlock(vault: Vault, dek: CryptoKey, method: UnlockMethod = 'passphrase'): Promise<boolean> {
  lastUnlockFailure = null;
  if (!(await checkVerifier(dek, vault.verifier))) {
    lastUnlockFailure = 'wrong-credential';
    return false;
  }

  // Validate ALL required vault secrets into locals BEFORE making the DEK live, so a
  // corrupt secrets blob aborts the unlock without leaving the DEK resident while the
  // UI still believes the vault is locked (ACR-008).
  let secrets: VaultSecrets | null;
  try {
    secrets = vault.secrets
      ? (JSON.parse(await decryptBlob(dek, vault.secrets)) as VaultSecrets)
      : null;
  } catch (err) {
    recordError('vault.finishUnlock.secrets', err);
    lastUnlockFailure = 'corrupt-vault';
    return false;
  }

  currentDek = dek;
  currentSecrets = secrets;
  idleTimeoutMs = (vault.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;

  try {
    // A successful unlock (passphrase OR security key) clears the failure tripwire.
    if ((vault.failedUnlockAttempts ?? 0) !== 0) {
      await db.vault.update('vault', { failedUnlockAttempts: 0 });
    }
    // Resume an interrupted migration.
    if (vault.migrationState === 'encrypting') {
      await completeEnable();
    } else if (vault.migrationState === 'decrypting') {
      await completeDisable();
      return true;
    }
  } catch (err) {
    // Roll back the in-memory unlock so a failed post-validation step can never leave
    // the DEK/secrets live behind a locked-looking UI (ACR-008).
    currentDek = null;
    currentSecrets = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    recordError('vault.finishUnlock.resume', err);
    lastUnlockFailure = 'resume-failed';
    return false;
  }

  // Backfill a uniform garbage slot 2 for vaults enabled before duress existed,
  // so its presence never signals whether duress is configured. A silent failure
  // here degrades that deniability, so it is recorded (the next unlock retries).
  if (!vault.wrappedDek2) {
    await db.vault.update('vault', { wrappedDek2: await generateGarbageSlot() })
      .catch((err) => recordError('vault.slot2Backfill', err));
  }
  // The tripwire reads `maxUnlockAttempts ?? 0`, i.e. DISABLED — but a vault
  // enabled before the field existed never got a value written, while Settings
  // renders the local mirror `?? DEFAULT_MAX_ATTEMPTS` and shows it armed. Make
  // the vault match what the UI has been promising. An explicit 0 the user chose
  // is a real value and is left alone; the notice flag lets Settings say once
  // that the wipe is now armed on this device.
  if (vault.maxUnlockAttempts === undefined) {
    try {
      // Notice FIRST, then arm. The other order can half-apply into the worst
      // outcome: a destructive tripwire silently switched on with no banner.
      await patchLocalSettings({
        paranoidMaxUnlockAttempts: DEFAULT_MAX_ATTEMPTS,
        paranoidAttemptWipeArmedNotice: true,
      });
      await db.vault.update('vault', { maxUnlockAttempts: DEFAULT_MAX_ATTEMPTS });
    } catch (err) {
      recordError('vault.armAttemptWipe', err);
    }
  }
  await recordUnlockEvent().catch((err) => recordError('vault.recordUnlockEvent', err));
  await recordUnlockAttempt(method, true, Date.now());
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
    dekWrappedByPrf: await wrapDek(kek, currentDek, `prf:${reg.credentialId}`),
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
  if (!currentDek) throw new Error('Unlock the vault before removing a security key');
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
  const dekWrappedByRuk = await wrapDek(kek, currentDek, 'ruk');
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
    dek = await unwrapDek(kek, vault.dekWrappedByRuk, 'ruk');
  } catch {
    await registerFailedAttempt('remote', false); // logged, but never wipes (see above)
    return false; // wrong RUK
  }
  const ok = await finishUnlock(vault, dek, 'remote');
  if (ok && isLegacyWrap(vault.dekWrappedByRuk)) {
    // Bind a pre-binding wrap to its slot now that its KEK is in hand (see vault-crypto).
    try {
      await db.vault.update('vault', { dekWrappedByRuk: await wrapDek(kek, dek, 'ruk') });
    } catch (err) {
      recordError('vault.slotBind', err);
    }
  }
  return ok;
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

/**
 * Re-wrap the DEK under a (possibly new) passphrase. The salt and KDF stay as they
 * are: slot 2 (the secondary passphrase) is wrapped under a KEK derived from them
 * and can't be re-wrapped without that passphrase, so a fresh salt here silently
 * turned it into a wrong passphrase. Only a legacy PBKDF2 vault moves to a new salt
 * and the current Argon2id params — setSecondaryPassphrase refuses those vaults, so
 * no slot 2 depends on what changes.
 */
async function rewrapPassphrase(passphrase: string): Promise<void> {
  if (!currentDek) return;
  const vault = await db.vault.get('vault');
  if (!vault) return;
  const upgrading = (vault.kdf?.algo ?? 'pbkdf2') !== DEFAULT_ARGON2.algo;
  const passSalt = upgrading ? generateSalt() : vault.passSalt;
  const kdf = upgrading ? kdfParams : (vault.kdf ?? kdfParams);
  const kek = await deriveVaultKek(passphrase, passSalt, kdf);
  const dekWrappedByPass = await wrapDek(kek, currentDek, 'slot1');
  await db.vault.update('vault', { passSalt, dekWrappedByPass, kdf });
}

/**
 * Change the passphrase. Needs the current one (the gate — see
 * confirmCurrentPassphrase). With `rekey` the device is rewritten under a fresh
 * DEK as well (rekeyVault); without it only slot 1 is re-wrapped, which keeps the
 * security keys and the secondary passphrase working. Requires the vault unlocked.
 */
export async function changePassphrase(
  currentPassphrase: string,
  newPassphrase: string,
  opts: { rekey: boolean },
): Promise<RekeyResult | null> {
  if (!currentDek) throw new Error('Unlock the vault before changing the passphrase');
  if (!newPassphrase) throw new Error('A passphrase is required');
  if (opts.rekey) return rekeyVault(currentPassphrase, newPassphrase);
  if (!(await confirmCurrentPassphrase(currentPassphrase))) throw new Error('Incorrect passphrase');
  await rewrapPassphrase(newPassphrase);
  return null;
}

/**
 * Rewrite this device under a fresh DEK, so a key that was ever copied out of
 * it — an old disk image plus the passphrase of that time, a security key since
 * removed, a trusted device since revoked, a memory dump — opens nothing written
 * from now on. Needs the current passphrase; `newPassphrase` changes it in the
 * same step. The secondary passphrase (if any) must be set again afterwards and
 * every security key enrolled again; remote unlock stays enrolled. Requires the
 * vault unlocked. Rejects with 'Incorrect passphrase' for anything but the main
 * passphrase — the secondary one included — counting and logging nothing.
 */
export async function rekeyVault(currentPassphrase: string, newPassphrase?: string): Promise<RekeyResult> {
  if (!currentDek) throw new Error('Unlock the vault first');
  if (rekeying) throw new Error('The vault is already being re-keyed');
  const { vault, mainPassphrase } = await authenticateMainPassphrase(currentPassphrase, 'vault.rekey');
  if (mainPassphrase === null) throw new Error('Incorrect passphrase');
  if (!currentDek) throw new Error('Unlock the vault first');
  if (vault.migrationState !== 'done') {
    throw new Error('Finish the pending encryption change first: lock and unlock once, then try again');
  }
  // The row read above must be the one this tab's key belongs to (another tab
  // may have re-keyed meanwhile — its reload signal reaches us only afterwards).
  if (!(await checkVerifier(currentDek, vault.verifier))) {
    throw new Error('The vault changed underneath this tab. Reload the app and try again');
  }
  // Recovered under the OLD key, before the swap; re-wrapped under the new one.
  const ruk = vault.dekWrappedByRuk ? await getRukRaw() : null;
  const newSalt = generateSalt();
  // Kept as it opened slot 1 — without whitespace typed around it (see passphraseCandidates).
  const newKek = await deriveVaultKek(newPassphrase ?? mainPassphrase, newSalt, kdfParams);

  // The other tabs hold the old key and would keep showing (and writing) under
  // it: lock them first. This tab stops rendering content (busy) and ends its
  // sync session, so nothing is read or written around the swap.
  signalOtherTabs({ type: 'lock' });
  rekeying = true;
  emit();
  try {
    const { newDek, result } = await rekeyVaultContent({
      vault, newKek, newSalt, kdf: kdfParams, secrets: currentSecrets, ruk,
    });
    currentDek = newDek;
    setKeyFlag(false); // the security keys' wraps opened the old DEK
    // The safety backups were encrypted under the old key: replace them with one
    // fresh copy under the new one, so the safety net is back immediately.
    purgeLocalBackups();
    await createLocalBackup();
    // The other tabs' memory still holds what they showed under the old key.
    signalOtherTabs({ type: 'reload' });
    return result;
  } finally {
    // On failure the transaction rolled back and currentDek still is the old key.
    if (ruk) ruk.fill(0);
    resetIdleTimer();
    endRekeyWindow();
    emit();
  }
}

export async function configureIdleTimeout(minutes: number): Promise<void> {
  idleTimeoutMs = minutes * 60_000;
  if (await db.vault.get('vault')) {
    await db.vault.update('vault', { idleTimeoutMinutes: minutes });
  }
  await patchLocalSettings({ paranoidIdleTimeoutMinutes: minutes });
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
  // An explicit choice supersedes the "we armed it for you" notice.
  await patchLocalSettings({ paranoidMaxUnlockAttempts: max, paranoidAttemptWipeArmedNotice: undefined });
}

// Test-only: reset in-memory state without touching persistence.
export function __resetVaultStateForTests(): void {
  currentDek = null;
  currentSecrets = null;
  lastUnlockFailure = null;
  rekeying = false;
  lockDeferredByRekey = false;
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
