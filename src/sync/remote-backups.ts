import { getFile, putFile } from './github-api';
import {
  encryptSyncData,
  getCachedSalt,
  createVerifier,
} from './crypto';
import { getLocalSnapshot } from './sync-engine';
import { SYNC_VERSION } from './version';
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
  // Gate: skip if checked recently
  if (Date.now() - lastBackupCheckAt < BACKUP_CHECK_INTERVAL_MS) return;
  lastBackupCheckAt = Date.now();

  const now = Date.now();
  const tiers = Object.keys(BACKUP_FILES) as BackupTier[];

  // Check localStorage for each tier — collect stale tiers
  let staleTiers = tiers.filter((tier) => {
    const lastAt = parseInt(localStorage.getItem(getLocalTimestampKey(tier)) ?? '0', 10);
    return now - lastAt >= TIER_THRESHOLDS[tier];
  });

  if (staleTiers.length === 0) return;

  // Random jitter: spread out devices to avoid thundering herd
  await new Promise((r) => setTimeout(r, Math.random() * 30_000));

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

  // Create encrypted snapshot once
  const localData = await getLocalSnapshot();
  const salt = getCachedSalt()!;
  localData.encryptionSalt = salt;
  localData.encryptionVerifier = await createVerifier(encKey);
  localData.syncVersion = SYNC_VERSION;
  const encrypted = await encryptSyncData(encKey, localData);

  const backedUpAt = Date.now();

  // Write all stale tiers in parallel
  await Promise.allSettled(
    tiersToWrite.map(async ({ tier, sha }) => {
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
    }),
  );
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
