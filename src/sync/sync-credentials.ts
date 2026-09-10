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
