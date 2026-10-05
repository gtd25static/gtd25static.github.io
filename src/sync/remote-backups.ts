import { getFile, putFile } from './github-api';
import {
  encryptSyncData,
  decryptSyncData,
  getCachedSalt,
  createVerifier,
  checkVerifier,
} from './crypto';
import { getLocalSnapshot, remoteKeyIsCurrent } from './sync-engine';
import { SYNC_VERSION } from './version';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import type { SyncData } from '../db/models';

// --- Types ---
export const BACKUP_FILES = {
  hourly: 'gtd25-backup-hourly.json',
  daily: 'gtd25-backup-daily.json',
  weekly: 'gtd25-backup-weekly.json',
} as const;

export type BackupTier = keyof typeof BACKUP_FILES;

export interface BackupInfo {
  tier: BackupTier;
  backedUpAt: number;
}

// --- Constants ---
const TIER_THRESHOLDS: Record<BackupTier, number> = {
  hourly: 3_600_000,       // 1 hour
  daily: 86_400_000,       // 24 hours
  weekly: 604_800_000,     // 7 days
};

const BACKUP_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// --- Module state ---
let lastBackupCheckAt = 0;

function getLocalTimestampKey(tier: BackupTier): string {
  return `gtd25-backup-${tier}-at`;
}

/**
 * Attempts to create backups for stale tiers. Called fire-and-forget after sync.
 * Uses local gates, remote freshness checks, random jitter, and GitHub SHA
 * optimistic locking to coordinate across devices.
 */
export async function maybeCreateBackups(
  pat: string,
  repo: string,
  encKey: CryptoKey,
): Promise<void> {
  // Paranoid devices initiate no remote backup PUTs — fewer writes for an
  // inspecting proxy to observe. Other (non-paranoid) devices keep them fresh.
  if (isParanoidFlagSet()) return;
  // Gate: skip if checked recently
  if (Date.now() - lastBackupCheckAt < BACKUP_CHECK_INTERVAL_MS) return;
  lastBackupCheckAt = Date.now();

  const now = Date.now();
  const tiers = Object.keys(BACKUP_FILES) as BackupTier[];

  // Check localStorage for each tier — collect stale tiers
  const staleTiers = tiers.filter((tier) => {
    const lastAt = parseInt(localStorage.getItem(getLocalTimestampKey(tier)) ?? '0', 10);
    return now - lastAt >= TIER_THRESHOLDS[tier];
  });

  if (staleTiers.length === 0) return;

  // Random jitter: spread out devices to avoid thundering herd
  await new Promise((r) => setTimeout(r, Math.random() * 30_000));
  // Checked again: Paranoid Mode may have been enabled during the wait — or the
  // vault locked, or re-keyed by the secondary passphrase — and what gets read and
  // pushed below is whatever this device holds by now.
  if (isParanoidFlagSet()) return;

  // Fetch existing backup files in parallel for SHA + remote freshness check
  const remoteResults = await Promise.allSettled(
    staleTiers.map((tier) => getFile(pat, repo, BACKUP_FILES[tier])),
  );

  // Check remote freshness — another device may have already backed up
  const tiersToWrite: Array<{ tier: BackupTier; sha?: string }> = [];
  for (let i = 0; i < staleTiers.length; i++) {
    const tier = staleTiers[i];
    const result = remoteResults[i];

    if (result.status === 'fulfilled' && result.value) {
      try {
        const remote = JSON.parse(result.value.data);
        if (remote.backedUpAt && now - remote.backedUpAt < TIER_THRESHOLDS[tier]) {
          // Another device already did it — update local timestamp and skip
          localStorage.setItem(getLocalTimestampKey(tier), String(remote.backedUpAt));
          continue;
        }
        tiersToWrite.push({ tier, sha: result.value.sha });
      } catch {
        tiersToWrite.push({ tier, sha: result.value.sha });
      }
    } else {
      // File doesn't exist or fetch failed — create it
      tiersToWrite.push({ tier });
    }
  }

  if (tiersToWrite.length === 0) return;
  // Not under a key the remote no longer uses: written after a sync-password
  // change (the jitter above is long enough), an old-key tier at the tip opened
  // with the old password again and with the new one not at all.
  if (!(await remoteKeyIsCurrent())) return;

  // Create encrypted snapshot once
  const localData = await getLocalSnapshot();
  const salt = getCachedSalt()!;
  localData.encryptionSalt = salt;
  localData.encryptionVerifier = await createVerifier(encKey);
  localData.syncVersion = SYNC_VERSION;
  const encrypted = await encryptSyncData(encKey, localData);

  const backedUpAt = Date.now();

  // One tier at a time: GitHub documents that concurrent writes to one branch
  // conflict, and the parallel PUTs made the tiers collide with each other.
  for (const { tier, sha } of tiersToWrite) {
    try {
      const backupData: SyncData & { backedUpAt: number } = {
        ...encrypted,
        backedUpAt,
      };
      await putFile(pat, repo, BACKUP_FILES[tier], JSON.stringify(backupData), sha);
      localStorage.setItem(getLocalTimestampKey(tier), String(backedUpAt));
    } catch {
      // 409 = another device won the race, network error = retry next period
      // Don't update localStorage — allow retry on next check cycle
    }
  }
}

/**
 * Re-encrypt all three tiers under the new key, now. A key rotation calls this:
 * the tiers hold the last snapshot each was taken from, under whatever key was
 * current then, and would otherwise keep old-key ciphertext at the tip for up to
 * a week. Each tier keeps ITS OWN content and time — they used to be overwritten
 * with today's snapshot, so a password change wiped out the hourly, daily and
 * weekly restore points. A tier already under the new key (a resumed rotation)
 * is left alone; one neither key opens holds nothing anyone can restore and is
 * replaced by `current`. Not gated by the Paranoid flag — a rotation is one
 * explicit burst of writes the user asked for.
 */
export async function rekeyAllBackups(
  pat: string, repo: string, oldKey: CryptoKey, newKey: CryptoKey, newSalt: string, current: SyncData,
): Promise<void> {
  const newVerifier = await createVerifier(newKey);
  for (const tier of Object.keys(BACKUP_FILES) as BackupTier[]) {
    const existing = await getFile(pat, repo, BACKUP_FILES[tier]);
    let backup: (SyncData & { backedUpAt?: number }) | null = null;
    try {
      backup = existing ? JSON.parse(existing.data) as SyncData & { backedUpAt?: number } : null;
    } catch {
      backup = null;
    }
    if (backup?.encryptionVerifier && backup.encryptionSalt === newSalt && await checkVerifier(newKey, backup.encryptionVerifier)) continue;
    let next: SyncData & { backedUpAt: number };
    let plain: SyncData | null = null;
    if (backup?.encryptionVerifier && await checkVerifier(oldKey, backup.encryptionVerifier)) {
      // A corrupt row in it would throw here and keep the change pending for
      // ever: such a tier is treated as one neither key opens.
      plain = await decryptSyncData(oldKey, backup).catch(() => null);
    }
    if (plain && backup) {
      const reencrypted = await encryptSyncData(newKey, { ...plain, encryptionSalt: newSalt, encryptionVerifier: newVerifier });
      next = { ...reencrypted, backedUpAt: backup.backedUpAt ?? Date.now() };
    } else {
      next = { ...current, syncVersion: SYNC_VERSION, backedUpAt: Date.now() };
    }
    await putFile(pat, repo, BACKUP_FILES[tier], JSON.stringify(next), existing?.sha);
    localStorage.setItem(getLocalTimestampKey(tier), String(next.backedUpAt));
  }
}

export function __resetForTesting() {
  lastBackupCheckAt = 0;
}

/**
 * Lists available remote backups without decrypting them.
 * Reads backedUpAt from the top-level JSON (not encrypted).
 */
export async function listRemoteBackups(
  pat: string,
  repo: string,
): Promise<BackupInfo[]> {
  const tiers = Object.keys(BACKUP_FILES) as BackupTier[];

  const results = await Promise.allSettled(
    tiers.map((tier) => getFile(pat, repo, BACKUP_FILES[tier])),
  );

  const backups: BackupInfo[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      try {
        const data = JSON.parse(result.value.data);
        if (data.backedUpAt) {
          backups.push({ tier: tiers[i], backedUpAt: data.backedUpAt });
        }
      } catch {
        // Corrupted file — skip
      }
    }
  }

  return backups;
}
