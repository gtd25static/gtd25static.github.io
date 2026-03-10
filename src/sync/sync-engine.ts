import { db } from '../db';
import type { SyncData, Settings, ChangeEntry } from '../db/models';
import type { ImportData } from '../db/export-import';
import { getFile, putFile, deleteFile } from './github-api';
import { cleanupSoftDeletes } from './conflict-resolution';
import { applyRemoteEntries, getPendingEntries, clearPendingEntries, clearEntriesByIds, pendingEntryCount } from './change-log';
import { toast } from '../components/ui/Toast';
import { SYNC_VERSION, isCompatibleVersion, needsMigration } from './version';
import { runRemoteMigrations } from './migrations';
import { maybeCreateBackups, BACKUP_FILES } from './remote-backups';
import type { BackupTier } from './remote-backups';
import {
  deriveKey,
  generateSalt,
  encryptSyncData,
  decryptSyncData,
  encryptChangeEntries,
  decryptChangeEntries,
  createVerifier,
  checkVerifier,
  hasEncryptionKey,
  getCachedEncryptionKey,
  cacheEncryptionKey,
  getCachedSalt,
  clearEncryptionKey,
} from './crypto';

export const SNAPSHOT_FILE = 'gtd25-snapshot.json';
export const CHANGELOG_FILE = 'gtd25-changelog.json';
const LEGACY_FILE = 'gtd25-data.json';
const COMPACTION_THRESHOLD = 30;
const MAX_RETRIES = 3;
const MAX_REMOTE_BACKUPS = 2;
const SYNC_TIMEOUT_MS = 45_000;

let syncStartedAt: number | null = null;
let syncAbort: AbortController | null = null;
let legacyChecked = false;

// --- Cached sync state for flushOnHide ---
let cachedChangelogSha: string | undefined;
let cachedRemoteEntries: ChangeEntry[] = [];
let cachedCreds: { pat: string; repo: string; deviceId: string } | null = null;

// --- Scheduler constants ---
const POLL_INTERVAL_MS = 30_000;
const FIRST_BATCH_DELAY_MS = 15_000;
const BATCH_INTERVAL_MS = 30_000;
const FIRST_BATCH_SIZE = 5;
const BATCH_SIZE = 10;

// --- Scheduler state machine ---
type SchedulerState = 'stopped' | 'idle' | 'first-wait' | 'batching';
let schedulerState: SchedulerState = 'stopped';
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

// --- Version incompatibility callbacks ---
type VersionCallback = () => void;
const versionIncompatibleListeners: Set<VersionCallback> = new Set();

export function onVersionIncompatible(cb: VersionCallback) {
  versionIncompatibleListeners.add(cb);
}

export function offVersionIncompatible(cb: VersionCallback) {
  versionIncompatibleListeners.delete(cb);
}

function notifyVersionIncompatible() {
  for (const cb of versionIncompatibleListeners) cb();
}

// --- Encryption password callbacks ---
type PasswordNeededCallback = (salt: string) => void;
const passwordNeededListeners: Set<PasswordNeededCallback> = new Set();

export function onEncryptionPasswordNeeded(cb: PasswordNeededCallback) {
  passwordNeededListeners.add(cb);
}

export function offEncryptionPasswordNeeded(cb: PasswordNeededCallback) {
  passwordNeededListeners.delete(cb);
}

function notifyPasswordNeeded(salt: string) {
  for (const cb of passwordNeededListeners) cb(salt);
}

// --- Sync progress reporting ---
export type SyncPhase = 'connecting' | 'pulling' | 'applying' | 'pushing' | 'compacting' | 'done' | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  label: string;
  progress: number; // 0 to 1
  pulled?: number;
  pushed?: number;
}

let onSyncProgress: ((progress: SyncProgress) => void) | null = null;

export function setSyncProgressCallback(cb: ((progress: SyncProgress) => void) | null) {
  onSyncProgress = cb;
}

function reportProgress(phase: SyncPhase, label: string, progress: number, pulled?: number, pushed?: number) {
  onSyncProgress?.({ phase, label, progress, pulled, pushed });
}

// --- Sync lock ---
function acquireSyncLock(): AbortSignal | null {
  if (syncStartedAt !== null) {
    if (Date.now() - syncStartedAt < SYNC_TIMEOUT_MS) return null; // still valid
    // Lock expired — force-reset and abort previous
    console.warn('Sync lock expired, force-resetting');
    syncAbort?.abort();
  }
  syncStartedAt = Date.now();
  syncAbort = new AbortController();
  return syncAbort.signal;
}

function releaseSyncLock() {
  syncStartedAt = null;
  syncAbort = null;
}

// --- Dirty flag ---
function setDirtyFlag(value: boolean) {
  if (value) {
    localStorage.setItem('gtd25-sync-dirty', '1');
  } else {
    localStorage.removeItem('gtd25-sync-dirty');
  }
}

export function hasDirtyFlag(): boolean {
  return localStorage.getItem('gtd25-sync-dirty') === '1';
}

// --- Scheduler functions ---

function clearSchedulerTimer() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function startIdlePoll() {
  clearSchedulerTimer();
  schedulerState = 'idle';
  schedulerTimer = setTimeout(async function poll() {
    if (schedulerState !== 'idle') return;
    await syncNow();
    if (schedulerState === 'idle') {
      schedulerTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }, POLL_INTERVAL_MS);
}

async function onBatchTimerFired(batchSize: number) {
  const remaining = await syncNow(false, batchSize);
  if (remaining > 0) {
    // More entries to push — continue batching
    schedulerState = 'batching';
    schedulerTimer = setTimeout(() => onBatchTimerFired(BATCH_SIZE), BATCH_INTERVAL_MS);
  } else {
    // All pushed — final pull then back to idle
    await syncNow();
    startIdlePoll();
  }
}

function notifyLocalChange() {
  if (schedulerState === 'stopped') return;
  if (schedulerState === 'idle') {
    clearSchedulerTimer();
    schedulerState = 'first-wait';
    schedulerTimer = setTimeout(() => onBatchTimerFired(FIRST_BATCH_SIZE), FIRST_BATCH_DELAY_MS);
  }
  // If already in first-wait or batching, let the current timer handle it
}

export function scheduleSyncDebounced() {
  notifyLocalChange();
}

async function flushOnHide() {
  if (!cachedCreds || !cachedChangelogSha || !hasEncryptionKey()) return;
  try {
    const pending = await getPendingEntries();
    if (pending.length === 0) return;
    const encKey = getCachedEncryptionKey()!;
    const encrypted = await encryptChangeEntries(encKey, pending);
    const updatedChangelog = [...cachedRemoteEntries, ...encrypted];
    const content = JSON.stringify(updatedChangelog);
    // Fire-and-forget PUT with keepalive — browser completes it after page suspends
    putFile(cachedCreds.pat, cachedCreds.repo, CHANGELOG_FILE, content, cachedChangelogSha, undefined, { keepalive: true });
  } catch {
    // Best-effort — data is safe in local IndexedDB
  }
}

function handleVisibilityChange() {
  if (schedulerState === 'stopped') return;
  if (document.visibilityState === 'hidden') {
    clearSchedulerTimer();
    schedulerState = 'idle';
    flushOnHide(); // single keepalive PUT, no GETs needed
  } else {
    // Visible — immediate pull then restart idle polling
    syncNow().then(() => startIdlePoll());
  }
}

function handleOnline() {
  if (schedulerState === 'stopped') return;
  syncNow().then(() => {
    if (schedulerState === 'idle') startIdlePoll();
  });
}

export function startScheduler() {
  syncNow(); // initial pull on startup
  startIdlePoll();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);
}

export function stopScheduler() {
  clearSchedulerTimer();
  schedulerState = 'stopped';
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('online', handleOnline);
}

async function getCredentials() {
  const local = await db.localSettings.get('local');
  if (!local?.githubPat || !local?.githubRepo || !local.syncEnabled) return null;
  return { pat: local.githubPat, repo: local.githubRepo, deviceId: local.deviceId ?? 'unknown' };
}

export async function getLocalSnapshot(): Promise<SyncData> {
  const [taskLists, tasks, subtasks] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.toArray(),
    db.subtasks.toArray(),
  ]);
  const settings: Settings = {
    theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system',
  };
  return { syncVersion: SYNC_VERSION, taskLists, tasks, subtasks, settings };
}

/**
 * Resolves the encryption key for a sync operation.
 * Encryption is ALWAYS required — returns CryptoKey or 'needs-password'.
 * Never returns null: sync cannot proceed without encryption.
 */
async function resolveEncryptionKey(
  remoteSalt?: string,
): Promise<CryptoKey | 'needs-password'> {
  const local = await db.localSettings.get('local');
  const localPassword = local?.encryptionPassword;

  // Check cached key
  if (hasEncryptionKey()) {
    const cachedSalt = getCachedSalt();
    if (remoteSalt && cachedSalt === remoteSalt) {
      return getCachedEncryptionKey()!;
    }
    if (!remoteSalt && localPassword) {
      // First-time encryption, cached key from previous setup still valid
      return getCachedEncryptionKey()!;
    }
    // Salt changed (password changed on another device) — clear cache
    clearEncryptionKey();
  }

  // No password available — prompt user
  if (!localPassword) {
    if (remoteSalt) {
      notifyPasswordNeeded(remoteSalt);
    } else {
      // No remote salt and no local password — user needs to set a password
      notifyPasswordNeeded('');
    }
    return 'needs-password';
  }

  // Derive key from password
  if (remoteSalt) {
    const key = await deriveKey(localPassword, remoteSalt);
    cacheEncryptionKey(key, remoteSalt);
    return key;
  }

  // No remote salt but local password set — first time encrypting, generate salt
  const salt = generateSalt();
  const key = await deriveKey(localPassword, salt);
  cacheEncryptionKey(key, salt);
  return key;
}

async function migrateFromLegacy(pat: string, repo: string): Promise<SyncData | null> {
  // Check if legacy file exists and new files don't
  const [legacy, snapshot] = await Promise.all([
    getFile(pat, repo, LEGACY_FILE),
    getFile(pat, repo, SNAPSHOT_FILE),
  ]);

  if (!legacy || snapshot) return null;

  // Parse legacy data for the caller to encrypt and write
  const legacyData: SyncData = JSON.parse(legacy.data);

  // Delete legacy file
  try {
    await deleteFile(pat, repo, LEGACY_FILE, legacy.sha);
  } catch {
    // Non-critical, leave it
  }

  return legacyData;
}

// --- Remote backup before migration ---
async function backupRemoteSnapshot(
  pat: string,
  repo: string,
  snapshotData: string,
  fromVersion: number,
) {
  try {
    const backupFile = `gtd25-snapshot-v${fromVersion}.backup.json`;
    await putFile(pat, repo, backupFile, snapshotData);
    await pruneRemoteBackups(pat, repo);
  } catch (err) {
    console.warn('Failed to create remote backup:', err);
    // Non-critical — proceed with migration
  }
}

async function pruneRemoteBackups(pat: string, repo: string) {
  try {
    // Check for known backup files by trying versions 0..SYNC_VERSION
    const backupFiles: Array<{ path: string; version: number; sha: string }> = [];
    for (let v = 0; v <= SYNC_VERSION; v++) {
      const file = await getFile(pat, repo, `gtd25-snapshot-v${v}.backup.json`);
      if (file) {
        backupFiles.push({ path: `gtd25-snapshot-v${v}.backup.json`, version: v, sha: file.sha });
      }
    }

    // Sort by version descending, delete oldest beyond limit
    backupFiles.sort((a, b) => b.version - a.version);
    for (const old of backupFiles.slice(MAX_REMOTE_BACKUPS)) {
      try {
        await deleteFile(pat, repo, old.path, old.sha);
      } catch {
        // Non-critical
      }
    }
  } catch {
    // Non-critical — skip pruning
  }
}

export async function syncNow(manual = false, pushLimit?: number): Promise<number> {
  const signal = acquireSyncLock();
  if (!signal) return -1;
  setDirtyFlag(true);

  try {
    const creds = await getCredentials();
    if (!creds) return -1;

    reportProgress('connecting', 'Connecting...', 0.1);

    // Legacy migration (skip after first check per session)
    let legacyData: SyncData | null = null;
    if (!legacyChecked) {
      legacyData = await migrateFromLegacy(creds.pat, creds.repo);
      legacyChecked = true;
    }
    if (legacyData) {
      // Encrypt and write as new snapshot
      const encKey = await resolveEncryptionKey();
      if (encKey === 'needs-password') return -1;
      const salt = getCachedSalt()!;
      legacyData.syncVersion = SYNC_VERSION;
      legacyData.encryptionSalt = salt;
      legacyData.encryptionVerifier = await createVerifier(encKey);
      const encrypted = await encryptSyncData(encKey, legacyData);
      await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(encrypted), undefined, signal);
      await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', undefined, signal);
      await clearPendingEntries();
      await db.syncMeta.update('sync-meta', {
        lastPulledAt: Date.now(),
        lastPushedAt: Date.now(),
        pendingChanges: false,
      });
      setDirtyFlag(false);
      reportProgress('done', 'Sync complete', 1.0);
      toast('Migrated sync data to new format', 'success');
      return 0;
    }

    // Fetch changelog and snapshot in parallel
    const [remoteChangelogFile, remoteSnapshotFile] = await Promise.all([
      getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal),
      getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal),
    ]);
    let remoteEntries: ChangeEntry[] = [];
    let changelogSha = remoteChangelogFile?.sha;

    if (remoteChangelogFile) {
      remoteEntries = JSON.parse(remoteChangelogFile.data);
    }

    reportProgress('pulling', 'Fetching changes...', 0.4);

    if (!remoteSnapshotFile && !remoteChangelogFile) {
      let localData = await getLocalSnapshot();
      const hasData = localData.taskLists.length > 0 || localData.tasks.length > 0 || localData.subtasks.length > 0;
      if (hasData) {
        // Encryption is always required
        const encKey = await resolveEncryptionKey();
        if (encKey === 'needs-password') return -1;
        const salt = getCachedSalt()!;
        localData.encryptionSalt = salt;
        localData.encryptionVerifier = await createVerifier(encKey);
        localData = await encryptSyncData(encKey, localData);
        const snapshotContent = JSON.stringify(localData);
        await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, snapshotContent, undefined, signal);
      }
      await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', undefined, signal);
      await clearPendingEntries();
      await db.syncMeta.update('sync-meta', {
        lastPulledAt: Date.now(),
        lastPushedAt: Date.now(),
        pendingChanges: false,
      });
      setDirtyFlag(false);
      reportProgress('done', 'Sync complete', 1.0);
      if (manual) toast('Initial sync complete', 'success');
      return 0;
    }

    // If snapshot exists but we have no local data, bootstrap from remote
    if (remoteSnapshotFile && !remoteChangelogFile) {
      // Snapshot exists but no changelog — apply snapshot then create empty changelog
      let snapshot: SyncData = JSON.parse(remoteSnapshotFile.data);

      // Decrypt (encryption is always required for sync)
      const encKey = await resolveEncryptionKey(snapshot.encryptionSalt);
      if (encKey === 'needs-password') return -1;
      if (snapshot.encryptionSalt) {
        const ok = await checkVerifier(encKey, snapshot.encryptionVerifier ?? '');
        if (!ok) {
          await db.localSettings.update('local', { encryptionPassword: undefined });
          clearEncryptionKey();
          notifyPasswordNeeded(snapshot.encryptionSalt);
          return -1;
        }
        snapshot = await decryptSyncData(encKey, snapshot);
      }

      await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
        await db.taskLists.clear();
        await db.tasks.clear();
        await db.subtasks.clear();
        await db.taskLists.bulkPut(snapshot.taskLists);
        await db.tasks.bulkPut(snapshot.tasks);
        await db.subtasks.bulkPut(snapshot.subtasks);
      });
      await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', undefined, signal);
      await clearPendingEntries();
      await db.syncMeta.update('sync-meta', {
        lastPulledAt: Date.now(),
        pendingChanges: false,
      });
      setDirtyFlag(false);
      reportProgress('done', 'Sync complete', 1.0);
      if (manual) toast('Synced from remote', 'success');
      return 0;
    }

    // --- Version check on remote snapshot ---
    let remoteSalt: string | undefined;
    let remoteVersion: number | undefined;
    let remoteWipedAt: number | undefined;
    if (remoteSnapshotFile) {
      const snapshotData: SyncData = JSON.parse(remoteSnapshotFile.data);
      remoteVersion = snapshotData.syncVersion;
      remoteSalt = snapshotData.encryptionSalt;
      remoteWipedAt = snapshotData.wipedAt;

      if (!isCompatibleVersion(remoteVersion)) {
        // Remote is ahead — block sync, notify UI
        notifyVersionIncompatible();
        reportProgress('error', 'Update required', 0);
        if (manual) toast('Remote data requires a newer app version', 'error');
        return -1;
      }
    }

    // --- wipedAt guard: force bootstrap if a wipe happened since our last pull ---
    if (remoteWipedAt && remoteSnapshotFile) {
      const syncMeta = await db.syncMeta.get('sync-meta');
      const lastPulledAt = syncMeta?.lastPulledAt;
      if (!lastPulledAt || remoteWipedAt > lastPulledAt) {
        // This device hasn't seen the wipe yet — force bootstrap
        const encResult = await resolveEncryptionKey(remoteSalt);
        if (encResult === 'needs-password') return -1;
        const encKey = encResult;

        // Verify password
        if (remoteSalt) {
          const snapshotData: SyncData = JSON.parse(remoteSnapshotFile.data);
          if (snapshotData.encryptionVerifier) {
            const ok = await checkVerifier(encKey, snapshotData.encryptionVerifier);
            if (!ok) {
              await db.localSettings.update('local', { encryptionPassword: undefined });
              clearEncryptionKey();
              notifyPasswordNeeded(remoteSalt);
              return -1;
            }
          }
        }

        let snapshot: SyncData = JSON.parse(remoteSnapshotFile.data);
        if (remoteSalt) {
          snapshot = await decryptSyncData(encKey, snapshot);
        }

        await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
          await db.taskLists.clear();
          await db.tasks.clear();
          await db.subtasks.clear();
          await db.taskLists.bulkPut(snapshot.taskLists);
          await db.tasks.bulkPut(snapshot.tasks);
          await db.subtasks.bulkPut(snapshot.subtasks);
        });
        await clearPendingEntries();

        // Clear any stale changelog so other devices don't re-apply old entries
        if (changelogSha) {
          try {
            await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', changelogSha, signal);
          } catch {
            // Non-critical — next sync will handle it
          }
        }

        await db.syncMeta.update('sync-meta', {
          lastPulledAt: Date.now(),
          lastPushedAt: Date.now(),
          pendingChanges: false,
        });
        setDirtyFlag(false);
        reportProgress('done', 'Sync complete', 1.0);
        return 0;
      }
    }

    // Resolve encryption key (always required)
    const encResult = await resolveEncryptionKey(remoteSalt);
    if (encResult === 'needs-password') return -1;
    const encKey = encResult;

    // Verify password against remote verifier
    if (remoteSalt && remoteSnapshotFile) {
      const snapshotData: SyncData = JSON.parse(remoteSnapshotFile.data);
      if (snapshotData.encryptionVerifier) {
        const ok = await checkVerifier(encKey, snapshotData.encryptionVerifier);
        if (!ok) {
          // Saved password is wrong — clear it and prompt
          await db.localSettings.update('local', { encryptionPassword: undefined });
          clearEncryptionKey();
          notifyPasswordNeeded(remoteSalt);
          return -1;
        }
      }
    }

    // Migrate remote snapshot if needed (after encryption is resolved)
    if (remoteSnapshotFile && needsMigration(remoteVersion)) {
      reportProgress('applying', 'Migrating data...', 0.45);
      await backupRemoteSnapshot(creds.pat, creds.repo, remoteSnapshotFile.data, remoteVersion ?? 0);
      // Decrypt → migrate → re-encrypt → write
      let snapshotData: SyncData = JSON.parse(remoteSnapshotFile.data);
      if (remoteSalt) {
        snapshotData = await decryptSyncData(encKey, snapshotData);
      }
      const migrated = runRemoteMigrations(snapshotData, remoteVersion ?? 0, SYNC_VERSION);
      migrated.encryptionSalt = getCachedSalt()!;
      migrated.encryptionVerifier = await createVerifier(encKey);
      const encrypted = await encryptSyncData(encKey, migrated);
      await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(encrypted), remoteSnapshotFile.sha, signal);
    }

    reportProgress('applying', 'Applying changes...', 0.6);

    // Filter out our own entries and apply remote ones (decrypt encrypted entries)
    let foreignEntries = remoteEntries.filter((e) => e.deviceId !== creds.deviceId);
    foreignEntries = await decryptChangeEntries(encKey, foreignEntries);
    if (foreignEntries.length > 0) {
      await applyRemoteEntries(foreignEntries);
    }

    // Get our pending local changes (optionally limited for batch pushes)
    let pendingEntries = await getPendingEntries(pushLimit);

    // Deduplicate: a previous flushOnHide may have pushed entries that weren't cleared locally
    if (pendingEntries.length > 0 && remoteEntries.length > 0) {
      const remoteIds = new Set(remoteEntries.map((e) => e.id));
      const dupes = pendingEntries.filter((e) => remoteIds.has(e.id));
      if (dupes.length > 0) {
        await clearEntriesByIds(dupes.map((e) => e.id));
        pendingEntries = pendingEntries.filter((e) => !remoteIds.has(e.id));
      }
    }

    // Track final changelog state for flushOnHide cache
    let finalChangelogSha = changelogSha;
    let finalRemoteEntries = remoteEntries;

    if (pendingEntries.length > 0) {
      reportProgress('pushing', 'Pushing updates...', 0.8);

      // Encrypt pending entries before pushing
      const entriesToPush = await encryptChangeEntries(encKey, pendingEntries);

      // Re-encrypt existing remote entries if first-time encryption
      // (they are plaintext from before encryption was enabled)
      let remoteToWrite = remoteEntries;
      if (!remoteSalt && remoteEntries.length > 0) {
        remoteToWrite = await encryptChangeEntries(encKey, remoteEntries);
      }

      // Append our entries to the remote changelog
      const updatedChangelog = [...remoteToWrite, ...entriesToPush];
      const content = JSON.stringify(updatedChangelog);

      let retries = 0;
      let pushed = false;
      let currentSha = changelogSha;

      while (!pushed && retries < MAX_RETRIES) {
        try {
          const newSha = await putFile(creds.pat, creds.repo, CHANGELOG_FILE, content, currentSha, signal);
          currentSha = newSha;
          pushed = true;
        } catch (err) {
          if (err instanceof Error && err.message === 'CONFLICT') {
            retries++;
            if (retries >= MAX_RETRIES) {
              toast('Sync conflict — will retry later', 'error');
              reportProgress('error', 'Sync conflict', 0.8);
              return -1;
            }
            // Re-fetch changelog and merge
            const fresh = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
            if (fresh) {
              const freshEntries: ChangeEntry[] = JSON.parse(fresh.data);
              currentSha = fresh.sha;
              // Apply any new foreign entries (decrypt them)
              let newForeign = freshEntries.filter(
                (e) => e.deviceId !== creds.deviceId && !remoteEntries.some((r) => r.id === e.id),
              );
              newForeign = await decryptChangeEntries(encKey, newForeign);
              if (newForeign.length > 0) {
                await applyRemoteEntries(newForeign);
              }
              // Rebuild: fresh remote + our pending encrypted (deduplicated)
              const pendingIds = new Set(entriesToPush.map((e) => e.id));
              let freshToWrite = freshEntries.filter((e) => !pendingIds.has(e.id));
              // Re-encrypt plaintext entries during first-time encryption
              if (!remoteSalt) {
                freshToWrite = await encryptChangeEntries(encKey, freshToWrite);
              }
              const merged = [
                ...freshToWrite,
                ...entriesToPush,
              ];
              const retryContent = JSON.stringify(merged);
              try {
                const retrySha = await putFile(creds.pat, creds.repo, CHANGELOG_FILE, retryContent, currentSha, signal);
                currentSha = retrySha;
                pushed = true;
              } catch {
                // Will loop and retry
              }
            }
            // Backoff
            await new Promise((r) => setTimeout(r, 500 * retries));
          } else {
            throw err;
          }
        }
      }

      if (pushed) {
        finalChangelogSha = currentSha;
        finalRemoteEntries = [...remoteToWrite, ...entriesToPush];
        if (pushLimit != null) {
          // Batch push — only clear the entries we just pushed
          await clearEntriesByIds(pendingEntries.map((e) => e.id));
        } else {
          await clearPendingEntries();
        }
      }
    }

    // Count remaining entries after push
    const remaining = await pendingEntryCount();

    // Update sync meta
    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(),
      lastPushedAt: pendingEntries.length > 0 ? Date.now() : undefined,
      pendingChanges: remaining > 0,
    });

    // First-time encryption: compact immediately to absorb all plaintext
    // changelog entries into the encrypted snapshot and clear the changelog.
    // Without this, pre-existing plaintext entries would remain on the remote.
    if (!remoteSalt) {
      reportProgress('compacting', 'Encrypting data...', 0.9);
      await compactSnapshot(creds.pat, creds.repo, encKey);
    } else {
      // Normal compaction threshold check
      const totalEntries = remoteEntries.length + pendingEntries.length;
      if (totalEntries >= COMPACTION_THRESHOLD) {
        reportProgress('compacting', 'Finalizing...', 0.95);
        await compactSnapshot(creds.pat, creds.repo, encKey);
      }
    }

    // Update flushOnHide cache with current sync state
    cachedCreds = creds;
    cachedChangelogSha = finalChangelogSha;
    cachedRemoteEntries = finalRemoteEntries;

    setDirtyFlag(false);
    reportProgress('done', 'Sync complete', 1.0, foreignEntries.length, pendingEntries.length);
    if (manual) toast('Sync complete', 'success');

    // Fire-and-forget: attempt backup creation (15-min gate makes this instant 99% of the time)
    maybeCreateBackups(creds.pat, creds.repo, encKey).catch(() => {});

    return remaining;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return -1;
    console.error('Sync failed:', err);
    const msg = err instanceof Error ? err.message : 'Sync failed';
    reportProgress('error', msg, 0);
    toast('Sync failed', 'error');
    return -1;
  } finally {
    releaseSyncLock();
  }
}

async function compactSnapshot(pat: string, repo: string, encKey: CryptoKey) {
  try {
    // Get current snapshot
    const snapshotFile = await getFile(pat, repo, SNAPSHOT_FILE);
    let snapshot: SyncData;
    let snapshotSha = snapshotFile?.sha;
    let savedSalt: string | undefined;
    let savedVerifier: string | undefined;
    let savedWipedAt: number | undefined;

    if (snapshotFile) {
      snapshot = JSON.parse(snapshotFile.data);
      savedSalt = snapshot.encryptionSalt;
      savedVerifier = snapshot.encryptionVerifier;
      savedWipedAt = snapshot.wipedAt;
      // Decrypt snapshot for merging
      if (savedSalt) {
        snapshot = await decryptSyncData(encKey, snapshot);
      }
    } else {
      snapshot = { taskLists: [], tasks: [], subtasks: [], settings: { theme: 'system' } };
    }

    // Get fresh changelog
    const changelogFile = await getFile(pat, repo, CHANGELOG_FILE);
    if (!changelogFile) return;

    let entries: ChangeEntry[] = JSON.parse(changelogFile.data);
    if (entries.length === 0) return;

    // Decrypt changelog entries for merging
    entries = await decryptChangeEntries(encKey, entries);

    // Apply all changelog entries to snapshot
    const entityMaps = {
      taskList: new Map(snapshot.taskLists.map((e) => [e.id, e])),
      task: new Map(snapshot.tasks.map((e) => [e.id, e])),
      subtask: new Map(snapshot.subtasks.map((e) => [e.id, e])),
    };

    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of sorted) {
      const map = entityMaps[entry.entityType];
      if (entry.operation === 'delete') {
        const existing = map.get(entry.entityId);
        if (existing) {
          (existing as unknown as Record<string, unknown>).deletedAt = entry.timestamp;
          (existing as unknown as Record<string, unknown>).updatedAt = entry.timestamp;
        }
      } else {
        map.set(entry.entityId, entry.data as never);
      }
    }

    snapshot.taskLists = Array.from(entityMaps.taskList.values());
    snapshot.tasks = Array.from(entityMaps.task.values());
    snapshot.subtasks = Array.from(entityMaps.subtask.values());

    // Cleanup soft-deletes older than 30 days
    snapshot = cleanupSoftDeletes(snapshot);

    // Stamp version and re-encrypt
    snapshot.syncVersion = SYNC_VERSION;
    // Preserve wipedAt unless changelog has entries after it (wipe fully absorbed)
    if (savedWipedAt) {
      const newestEntry = sorted.length > 0 ? sorted[sorted.length - 1].timestamp : 0;
      if (newestEntry <= savedWipedAt) {
        snapshot.wipedAt = savedWipedAt;
      }
      // else: entries exist after wipe — all devices have absorbed it, let wipedAt fall off
    }
    snapshot.encryptionSalt = savedSalt ?? getCachedSalt()!;
    snapshot.encryptionVerifier = savedVerifier ?? await createVerifier(encKey);
    snapshot = await encryptSyncData(encKey, snapshot);

    // Write updated snapshot
    const snapshotContent = JSON.stringify(snapshot);
    await putFile(pat, repo, SNAPSHOT_FILE, snapshotContent, snapshotSha);

    // Clear changelog (if 409, abort — new entries will be in next compaction)
    try {
      await putFile(pat, repo, CHANGELOG_FILE, '[]', changelogFile.sha);
    } catch {
      // Non-critical, next compaction will handle it
    }
  } catch (err) {
    console.error('Compaction failed:', err);
    // Non-critical, sync still works
  }
}

export async function forcePush() {
  const signal = acquireSyncLock();
  if (!signal) return;

  try {
    const creds = await getCredentials();
    if (!creds) return;

    reportProgress('connecting', 'Connecting...', 0.1);

    // Check existing remote for encryption state
    const existing = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal);

    // Backup current remote snapshot before overwriting
    if (existing) {
      const existingData: SyncData = JSON.parse(existing.data);
      await backupRemoteSnapshot(creds.pat, creds.repo, existing.data, existingData.syncVersion ?? SYNC_VERSION);
    }

    // If key is already cached (e.g. password was just changed), use it directly.
    // Otherwise resolve from remote salt + saved password.
    let encKey: CryptoKey;
    if (hasEncryptionKey()) {
      encKey = getCachedEncryptionKey()!;
    } else {
      const existingSalt = existing ? (JSON.parse(existing.data) as SyncData).encryptionSalt : undefined;
      const encResult = await resolveEncryptionKey(existingSalt);
      if (encResult === 'needs-password') return;
      encKey = encResult;
    }

    let localData = await getLocalSnapshot();

    // Always encrypt before pushing
    const salt = getCachedSalt()!;
    localData.encryptionSalt = salt;
    localData.encryptionVerifier = await createVerifier(encKey);
    localData = await encryptSyncData(encKey, localData);

    const content = JSON.stringify(localData);

    reportProgress('pushing', 'Pushing all data...', 0.4);

    // Overwrite snapshot with full local state
    await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, content, existing?.sha, signal);

    reportProgress('pushing', 'Clearing changelog...', 0.8);

    // Clear changelog
    const changelog = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
    await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', changelog?.sha, signal);

    // Clear local change log
    await clearPendingEntries();

    await db.syncMeta.update('sync-meta', {
      lastPushedAt: Date.now(),
      pendingChanges: false,
    });
    reportProgress('done', 'Sync complete', 1.0);
    toast('Force push complete', 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('Force push failed:', err);
    reportProgress('error', 'Force push failed', 0);
    toast('Force push failed', 'error');
  } finally {
    releaseSyncLock();
  }
}

export async function forcePull() {
  const signal = acquireSyncLock();
  if (!signal) return;

  try {
    const creds = await getCredentials();
    if (!creds) return;

    reportProgress('connecting', 'Connecting...', 0.1);

    // Bootstrap: load snapshot + apply changelog on top
    const snapshotFile = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal);
    if (!snapshotFile) {
      toast('No remote data found', 'error');
      reportProgress('error', 'No remote data', 0);
      return;
    }

    reportProgress('pulling', 'Fetching data...', 0.4);

    let snapshot: SyncData = JSON.parse(snapshotFile.data);

    if (!isCompatibleVersion(snapshot.syncVersion)) {
      notifyVersionIncompatible();
      reportProgress('error', 'Update required', 0);
      toast('Remote data requires a newer app version', 'error');
      return;
    }

    // Resolve encryption (always required)
    const encResult = await resolveEncryptionKey(snapshot.encryptionSalt);
    if (encResult === 'needs-password') return;
    const encKey = encResult;
    if (snapshot.encryptionSalt) {
      const ok = await checkVerifier(encKey, snapshot.encryptionVerifier ?? '');
      if (!ok) {
        await db.localSettings.update('local', { encryptionPassword: undefined });
        clearEncryptionKey();
        notifyPasswordNeeded(snapshot.encryptionSalt);
        return;
      }
      snapshot = await decryptSyncData(encKey, snapshot);
    }

    reportProgress('applying', 'Applying data...', 0.6);

    // Apply snapshot as full state
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
      await db.taskLists.clear();
      await db.tasks.clear();
      await db.subtasks.clear();
      await db.taskLists.bulkPut(snapshot.taskLists);
      await db.tasks.bulkPut(snapshot.tasks);
      await db.subtasks.bulkPut(snapshot.subtasks);
    });

    // Apply changelog entries on top
    const changelogFile = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
    if (changelogFile) {
      let entries: ChangeEntry[] = JSON.parse(changelogFile.data);
      entries = await decryptChangeEntries(encKey, entries);
      if (entries.length > 0) {
        await applyRemoteEntries(entries);
      }
    }

    if (snapshot.settings?.theme) {
      localStorage.setItem('gtd25-theme', snapshot.settings.theme);
    }

    // Clear local change log
    await clearPendingEntries();

    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(),
      pendingChanges: false,
    });
    reportProgress('done', 'Sync complete', 1.0);
    toast('Force pull complete', 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('Force pull failed:', err);
    reportProgress('error', 'Force pull failed', 0);
    toast('Force pull failed', 'error');
  } finally {
    releaseSyncLock();
  }
}

export async function wipeAllData() {
  const signal = acquireSyncLock();
  if (!signal) return;

  try {
    // Clear local task data
    await Promise.all([
      db.taskLists.clear(),
      db.tasks.clear(),
      db.subtasks.clear(),
      clearPendingEntries(),
    ]);

    // Push empty snapshot to remote if sync is configured
    const creds = await getCredentials();
    if (creds && hasEncryptionKey()) {
      const encKey = getCachedEncryptionKey()!;
      const salt = getCachedSalt()!;

      let emptySnapshot: SyncData = {
        syncVersion: SYNC_VERSION,
        wipedAt: Date.now(),
        taskLists: [],
        tasks: [],
        subtasks: [],
        settings: { theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system' },
        encryptionSalt: salt,
        encryptionVerifier: await createVerifier(encKey),
      };
      emptySnapshot = await encryptSyncData(encKey, emptySnapshot);

      const existing = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal);
      await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(emptySnapshot), existing?.sha, signal);

      // Delete changelog so other devices hit the bootstrap path
      // and load the empty snapshot instead of applying entries incrementally
      const changelog = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
      if (changelog) {
        await deleteFile(creds.pat, creds.repo, CHANGELOG_FILE, changelog.sha);
      }
    }

    await db.syncMeta.update('sync-meta', {
      lastPushedAt: Date.now(),
      pendingChanges: false,
    });

    toast('All data wiped', 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('Wipe failed:', err);
    toast('Wipe failed', 'error');
  } finally {
    releaseSyncLock();
  }
}

export async function importData(data: ImportData) {
  const signal = acquireSyncLock();
  if (!signal) return;

  try {
    // Replace local data
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
      await db.taskLists.clear();
      await db.tasks.clear();
      await db.subtasks.clear();
      await db.taskLists.bulkPut(data.taskLists);
      await db.tasks.bulkPut(data.tasks);
      await db.subtasks.bulkPut(data.subtasks);
    });

    await clearPendingEntries();

    // Push to remote if sync is configured
    const creds = await getCredentials();
    if (creds && hasEncryptionKey()) {
      const encKey = getCachedEncryptionKey()!;
      const salt = getCachedSalt()!;

      const theme = data.settings?.theme ?? (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system';
      let snapshot: SyncData = {
        syncVersion: SYNC_VERSION,
        wipedAt: Date.now(),
        taskLists: data.taskLists,
        tasks: data.tasks,
        subtasks: data.subtasks,
        settings: { theme },
        encryptionSalt: salt,
        encryptionVerifier: await createVerifier(encKey),
      };
      snapshot = await encryptSyncData(encKey, snapshot);

      const existing = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal);
      await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(snapshot), existing?.sha, signal);

      // Delete changelog so other devices bootstrap from the imported snapshot
      const changelog = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
      if (changelog) {
        await deleteFile(creds.pat, creds.repo, CHANGELOG_FILE, changelog.sha);
      }
    }

    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(),
      lastPushedAt: Date.now(),
      pendingChanges: false,
    });

    // Apply theme from imported settings
    if (data.settings?.theme) {
      localStorage.setItem('gtd25-theme', data.settings.theme);
    }

    toast('Backup imported successfully', 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('Import failed:', err);
    toast('Import failed', 'error');
  } finally {
    releaseSyncLock();
  }
}

export function __resetForTesting() {
  stopScheduler();
  syncStartedAt = null;
  syncAbort = null;
  legacyChecked = false;
  cachedChangelogSha = undefined;
  cachedRemoteEntries = [];
  cachedCreds = null;
  versionIncompatibleListeners.clear();
  passwordNeededListeners.clear();
  onSyncProgress = null;
}

export async function restoreFromBackup(tier: BackupTier) {
  const signal = acquireSyncLock();
  if (!signal) return;

  try {
    const creds = await getCredentials();
    if (!creds) {
      toast('Sync not configured', 'error');
      return;
    }

    // Resolve encryption key
    const encResult = await resolveEncryptionKey();
    if (encResult === 'needs-password') {
      toast('Encryption password required', 'error');
      return;
    }
    const encKey = encResult;

    // Fetch backup file
    const backupFile = await getFile(creds.pat, creds.repo, BACKUP_FILES[tier], signal);
    if (!backupFile) {
      toast('Backup file not found', 'error');
      return;
    }

    // Decrypt backup
    let backupData: SyncData = JSON.parse(backupFile.data);
    if (backupData.encryptionSalt) {
      const ok = await checkVerifier(encKey, backupData.encryptionVerifier ?? '');
      if (!ok) {
        toast('Wrong encryption password for this backup', 'error');
        return;
      }
      backupData = await decryptSyncData(encKey, backupData);
    }

    // Replace local data
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
      await db.taskLists.clear();
      await db.tasks.clear();
      await db.subtasks.clear();
      await db.taskLists.bulkPut(backupData.taskLists);
      await db.tasks.bulkPut(backupData.tasks);
      await db.subtasks.bulkPut(backupData.subtasks);
    });

    await clearPendingEntries();

    // Push as new snapshot with wipedAt so other devices bootstrap from restored data
    const salt = getCachedSalt()!;
    let snapshot: SyncData = {
      syncVersion: SYNC_VERSION,
      wipedAt: Date.now(),
      taskLists: backupData.taskLists,
      tasks: backupData.tasks,
      subtasks: backupData.subtasks,
      settings: backupData.settings ?? {
        theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system',
      },
      encryptionSalt: salt,
      encryptionVerifier: await createVerifier(encKey),
    };
    snapshot = await encryptSyncData(encKey, snapshot);

    const existing = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE, signal);
    await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(snapshot), existing?.sha, signal);

    // Delete changelog so other devices bootstrap from the restored snapshot
    const changelog = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
    if (changelog) {
      await deleteFile(creds.pat, creds.repo, CHANGELOG_FILE, changelog.sha);
    }

    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(),
      lastPushedAt: Date.now(),
      pendingChanges: false,
    });

    // Apply theme from backup settings
    if (backupData.settings?.theme) {
      localStorage.setItem('gtd25-theme', backupData.settings.theme);
    }

    toast('Backup restored successfully', 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('Restore failed:', err);
    toast('Restore failed', 'error');
  } finally {
    releaseSyncLock();
  }
}
