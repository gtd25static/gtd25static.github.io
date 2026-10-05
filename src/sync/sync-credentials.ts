import { db } from '../db';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { getVaultSecrets, setVaultSecrets } from '../db/vault';

// Where this device keeps its sync secrets: inside the encrypted vault when
// Paranoid Mode is on (see vault.ts), in localSettings otherwise — the same split
// as sync-engine's getCredentials / resolveEncryptionKey and GitHubSettings.

/** The GitHub PAT, or undefined when none is available (e.g. the vault is locked). */
export async function getSyncPat(): Promise<string | undefined> {
  if (isParanoidFlagSet()) return getVaultSecrets()?.githubPat;
  return (await db.localSettings.get('local'))?.githubPat;
}

/** Remember the sync password for future syncs. Paranoid: needs the vault unlocked. */
export async function rememberSyncPassword(password: string): Promise<void> {
  if (isParanoidFlagSet()) await setVaultSecrets({ syncPassword: password });
  else await db.localSettings.update('local', { encryptionPassword: password });
}

/**
 * The password and salt in force before an unfinished sync-password change:
 * kept beside the current password (same protection) until it completes, so a
 * retry after its commit point can still open what the old key covers.
 */
export async function rememberPreviousSyncPassword(password: string, salt: string): Promise<void> {
  if (isParanoidFlagSet()) await setVaultSecrets({ previousSyncPassword: password, previousSyncSalt: salt });
  else await db.localSettings.update('local', { previousEncryptionPassword: password, previousEncryptionSalt: salt });
}

export async function getPreviousSyncPassword(): Promise<{ password: string; salt: string } | null> {
  if (isParanoidFlagSet()) {
    const s = getVaultSecrets();
    return s?.previousSyncPassword && s.previousSyncSalt ? { password: s.previousSyncPassword, salt: s.previousSyncSalt } : null;
  }
  const local = await db.localSettings.get('local');
  return local?.previousEncryptionPassword && local.previousEncryptionSalt
    ? { password: local.previousEncryptionPassword, salt: local.previousEncryptionSalt }
    : null;
}

export async function forgetPreviousSyncPassword(): Promise<void> {
  if (isParanoidFlagSet()) await setVaultSecrets({ previousSyncPassword: undefined, previousSyncSalt: undefined });
  else await db.localSettings.update('local', { previousEncryptionPassword: undefined, previousEncryptionSalt: undefined });
}

/** Drop the stored sync password (the next sync asks for it). Paranoid: needs the vault unlocked. */
export async function forgetSyncPassword(): Promise<void> {
  if (isParanoidFlagSet()) await setVaultSecrets({ syncPassword: undefined });
  else await db.localSettings.update('local', { encryptionPassword: undefined });
}
