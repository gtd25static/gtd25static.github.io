import { db } from '../db';
import type { SyncData, Settings, ChangeEntry } from '../db/models';
import type { ImportData } from '../db/export-import';
import { getFile, putFile, deleteFile, RateLimitError } from './github-api';
import { cleanupSoftDeletes, archiveOldCompleted } from './conflict-resolution';
import { applyRemoteEntries, getPendingEntries, clearPendingEntries, clearEntriesByIds, pendingEntryCount, recordChange } from './change-log';
import { mergeEntity, stampUpdatedFields } from './field-timestamps';
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
const MAX_CHANGELOG_ENTRIES = 500;
const MAX_RETRIES = 3;
const MAX_REMOTE_BACKUPS = 2;
const SYNC_TIMEOUT_MS = 45_000;

// --- Snapshot reconciliation (catches compaction gaps) ---
async function reconcileFromSnapshot(snapshot: SyncData) {
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
    // Helper: reconcile a collection using field-level merge
    async function reconcileCollection<T extends { id: string; updatedAt: number }>(
      table: import('dexie').Table<T, string>,
      remoteEntities: T[],
    ) {
      const localMap = new Map<string, T>();
      for (const e of await table.toArray()) localMap.set(e.id, e);

      const toPut: T[] = [];
      for (const remote of remoteEntities) {
        const local = localMap.get(remote.id);
        if (!local) {
          toPut.push(remote);
        } else {
          const merged = mergeEntity(
            local as unknown as Record<string, unknown>,
            remote as unknown as Record<string, unknown>,
            remote.updatedAt,
          );
          if (merged) toPut.push(merged as unknown as T);
        }
      }
      if (toPut.length > 0) await table.bulkPut(toPut);
    }

    await reconcileCollection(db.taskLists, snapshot.taskLists);
    await reconcileCollection(db.tasks, snapshot.tasks);
    await reconcileCollection(db.subtasks, snapshot.subtasks);
  });

  // Reconcile pomodoro settings (outside entity transaction)
  if (snapshot.pomodoroSettings) {
    const local = await db.pomodoroSettings.get('pomodoro');
    if (!local || (snapshot.pomodoroSettings.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
      await db.pomodoroSettings.put(snapshot.pomodoroSettings);
    }
  }

  // Reconcile sound presets
  if (snapshot.soundPresets && snapshot.soundPresets.length > 0) {
    const localPresets = new Map(
      (await db.soundPresets.toArray()).map(p => [p.id, p.updatedAt])
    );
    for (const preset of snapshot.soundPresets) {
      const localTs = localPresets.get(preset.id);
      if (localTs === undefined || preset.updatedAt > localTs) {
        await db.soundPresets.put(preset);
      }
    }
  }
}

// --- Safe JSON parsing ---
function safeParseJson<T>(raw: string, label: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw);
    return { ok: true, value: parsed as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to parse ${label}: ${msg}`);
    return { ok: false, error: msg };
  }
}

let syncStartedAt: number | null = null;
let syncAbort: AbortController | null = null;
let legacyChecked = localStorage.getItem('gtd25-legacy-checked') === '1';

// --- Cached sync state for flushOnHide ---
let cachedChangelogSha: string | undefined;
let cachedRemoteEntries: ChangeEntry[] = [];
let cachedCreds: { pat: string; repo: string; deviceId: string } | null = null;
let cachedChangelogTimestamp = 0;

// --- Scheduler constants ---
const POLL_INTERVAL_MS = 30_000;
const FIRST_BATCH_DELAY_MS = 15_000;
const IDLE_THRESHOLD_MS = 3_000; // Sync after 3s of user inactivity
const BATCH_INTERVAL_MS = 30_000;
const FIRST_BATCH_SIZE = 5;
const BATCH_SIZE = 10;
const MIN_RESYNC_INTERVAL_MS = 10_000;

// --- Scheduler state machine ---
type SchedulerState = 'stopped' | 'idle' | 'first-wait' | 'batching';
let schedulerState: SchedulerState = 'stopped';
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncCompletedAt = 0;

// --- Batch accumulator: accumulates pulled/pushed counts across a batch cycle ---
let batchAccum: { pulled: number; pushed: number } | null = null;

// --- Idle-aware sync state ---
let lastActivityAt = Date.now();
let batchDeadline: number | null = null;

// --- Error backoff state ---
let consecutiveErrors = 0;
let rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
let lastErrorToastAt = 0;

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

// --- Sync success callbacks ---
const syncSuccessListeners: Set<() => void> = new Set();

export function onSyncSuccess(cb: () => void) {
  syncSuccessListeners.add(cb);
}

export function offSyncSuccess(cb: () => void) {
  syncSuccessListeners.delete(cb);
}

function notifySyncSuccess() {
  for (const cb of syncSuccessListeners) cb();
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

function getBackoffInterval(): number {
  if (consecutiveErrors === 0) return POLL_INTERVAL_MS;
  // Exponential backoff: 30s → 60s → 120s → 240s → 300s (cap at 5 min)
  return Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors), 300_000);
}

function startIdlePoll() {
  clearSchedulerTimer();
  batchAccum = null;
  batchDeadline = null;
  schedulerState = 'idle';
  const interval = getBackoffInterval();
  schedulerTimer = setTimeout(async function poll() {
    if (schedulerState !== 'idle') return;
    await syncNow();
    if (schedulerState === 'idle') {
      schedulerTimer = setTimeout(poll, getBackoffInterval());
    }
  }, interval);
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

function scheduleIdleCheck() {
  clearSchedulerTimer();
  const now = Date.now();
  const idleSince = now - lastActivityAt;
  const deadline = batchDeadline!;

  if (idleSince >= IDLE_THRESHOLD_MS || now >= deadline) {
    batchDeadline = null;
    onBatchTimerFired(FIRST_BATCH_SIZE);
    return;
  }

  const nextIdleAt = lastActivityAt + IDLE_THRESHOLD_MS;
  const delay = Math.min(nextIdleAt - now, deadline - now);
  schedulerTimer = setTimeout(scheduleIdleCheck, delay);
}

function notifyLocalChange() {
  if (schedulerState === 'stopped') return;
  lastActivityAt = Date.now();
  if (schedulerState === 'idle') {
    clearSchedulerTimer();
    batchAccum = { pulled: 0, pushed: 0 };
    schedulerState = 'first-wait';
    batchDeadline = Date.now() + FIRST_BATCH_DELAY_MS;
    scheduleIdleCheck();
  }
  // If already in first-wait or batching, activity timestamp is updated above
}

export function scheduleSyncDebounced() {
  // Mark pending immediately so UI shows "Pending" before sync starts
  db.syncMeta.update('sync-meta', { pendingChanges: true });
  notifyLocalChange();
}

async function flushOnHide() {
  if (!cachedCreds || !cachedChangelogSha || !hasEncryptionKey()) return;
  // Skip flush if cached state is stale (>60s since last sync).
  // Data is safe in IndexedDB and will sync on next visibility change.
  if (Date.now() - cachedChangelogTimestamp > 60_000) return;
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
    // Visible — skip sync if we synced recently
    if (Date.now() - lastSyncCompletedAt < MIN_RESYNC_INTERVAL_MS) {
      startIdlePoll();
      return;
    }
    syncNow().then(() => startIdlePoll());
  }
}

function handleOnline() {
  if (schedulerState === 'stopped') return;
  syncNow().then(() => {
    if (schedulerState === 'idle') startIdlePoll();
  });
}

function onUserActivity() {
  lastActivityAt = Date.now();
}

export function startScheduler() {
  syncNow(); // initial pull on startup
  startIdlePoll();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);
  document.addEventListener('pointerdown', onUserActivity, { passive: true });
  document.addEventListener('keydown', onUserActivity, { passive: true });
}

export function stopScheduler() {
  clearSchedulerTimer();
  schedulerState = 'stopped';
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('online', handleOnline);
  document.removeEventListener('pointerdown', onUserActivity);
  document.removeEventListener('keydown', onUserActivity);
}

async function getCredentials() {
  const local = await db.localSettings.get('local');
  if (!local?.githubPat || !local?.githubRepo || !local.syncEnabled) return null;
  return { pat: local.githubPat, repo: local.githubRepo, deviceId: local.deviceId ?? 'unknown' };
}

export async function getLocalSnapshot(): Promise<SyncData> {
  const { taskLists, tasks, subtasks } = await db.transaction(
    'r',
    [db.taskLists, db.tasks, db.subtasks],
    async () => ({
      taskLists: await db.taskLists.toArray(),
      tasks: await db.tasks.toArray(),
      subtasks: await db.subtasks.toArray(),
    }),
  );
  const settings: Settings = {
    theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system',
  };
  const pomodoroSettings = await db.pomodoroSettings.get('pomodoro') ?? undefined;
  const soundPresets = await db.soundPresets.toArray();
  return {
    syncVersion: SYNC_VERSION, taskLists, tasks, subtasks, settings,
    pomodoroSettings, soundPresets,
  };
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
  const parsed = safeParseJson<SyncData>(legacy.data, 'legacy sync data');
  if (!parsed.ok) return null;
  const legacyData = parsed.value;

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

  // Skip network calls when offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    releaseSyncLock();
    return -1;
  }

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
      localStorage.setItem('gtd25-legacy-checked', '1');
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
      lastSyncCompletedAt = Date.now();
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
      const parsed = safeParseJson<ChangeEntry[]>(remoteChangelogFile.data, 'remote changelog');
      if (parsed.ok) {
        remoteEntries = parsed.value;
      }
      // On parse failure, treat as empty — entries are safe in the snapshot
    }

    reportProgress('pulling', 'Fetching changes...', 0.4);

    // Force compaction when changelog is oversized
    if (remoteEntries.length > MAX_CHANGELOG_ENTRIES) {
      const encResult = await resolveEncryptionKey();
      if (encResult !== 'needs-password') {
        reportProgress('compacting', 'Compacting oversized changelog...', 0.35);
        await compactSnapshot(creds.pat, creds.repo, encResult);
        // Re-fetch after compaction
        const freshChangelog = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
        if (freshChangelog) {
          const freshParsed = safeParseJson<ChangeEntry[]>(freshChangelog.data, 'remote changelog (post-compaction)');
          remoteEntries = freshParsed.ok ? freshParsed.value : [];
          changelogSha = freshChangelog.sha;
        } else {
          remoteEntries = [];
          changelogSha = undefined;
        }
      }
    }

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
      lastSyncCompletedAt = Date.now();
      setDirtyFlag(false);
      reportProgress('done', 'Sync complete', 1.0);
      if (manual) toast('Initial sync complete', 'success');
      return 0;
    }

    // If snapshot exists but we have no local data, bootstrap from remote
    if (remoteSnapshotFile && !remoteChangelogFile) {
      // Snapshot exists but no changelog — apply snapshot then create empty changelog
      const snapshotParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (bootstrap)');
      if (!snapshotParsed.ok) {
        reportProgress('error', 'Remote data corrupted', 0);
        toast('Remote data corrupted — cannot sync', 'error');
        return -1;
      }
      let snapshot = snapshotParsed.value;

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
      if (snapshot.pomodoroSettings) {
        await db.pomodoroSettings.put(snapshot.pomodoroSettings);
      }
      if (snapshot.soundPresets && snapshot.soundPresets.length > 0) {
        await db.soundPresets.clear();
        await db.soundPresets.bulkPut(snapshot.soundPresets);
      }
      await putFile(creds.pat, creds.repo, CHANGELOG_FILE, '[]', undefined, signal);
      await clearPendingEntries();
      await db.syncMeta.update('sync-meta', {
        lastPulledAt: Date.now(),
        pendingChanges: false,
      });
      lastSyncCompletedAt = Date.now();
      setDirtyFlag(false);
      reportProgress('done', 'Sync complete', 1.0);
      if (manual) toast('Synced from remote', 'success');
      return 0;
    }

    // Both files exist but this device has never synced — full bootstrap
    if (remoteSnapshotFile && remoteChangelogFile) {
      const syncMeta = await db.syncMeta.get('sync-meta');
      if (!syncMeta?.lastPulledAt) {
        const snapshotParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (fresh bootstrap)');
        if (!snapshotParsed.ok) {
          reportProgress('error', 'Remote data corrupted', 0);
          toast('Remote data corrupted — cannot sync', 'error');
          return -1;
        }
        let snapshot = snapshotParsed.value;

        if (!isCompatibleVersion(snapshot.syncVersion)) {
          notifyVersionIncompatible();
          reportProgress('error', 'Update required', 0);
          toast('Remote data requires a newer app version', 'error');
          return -1;
        }

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

        reportProgress('applying', 'Applying data...', 0.6);

        // Apply snapshot
        await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
          await db.taskLists.clear();
          await db.tasks.clear();
          await db.subtasks.clear();
          await db.taskLists.bulkPut(snapshot.taskLists);
          await db.tasks.bulkPut(snapshot.tasks);
          await db.subtasks.bulkPut(snapshot.subtasks);
        });
        if (snapshot.pomodoroSettings) {
          await db.pomodoroSettings.put(snapshot.pomodoroSettings);
        }
        if (snapshot.soundPresets && snapshot.soundPresets.length > 0) {
          await db.soundPresets.clear();
          await db.soundPresets.bulkPut(snapshot.soundPresets);
        }
        if (snapshot.settings?.theme) {
          localStorage.setItem('gtd25-theme', snapshot.settings.theme);
        }

        // Apply changelog entries on top
        const clParsed = safeParseJson<ChangeEntry[]>(remoteChangelogFile.data, 'changelog (fresh bootstrap)');
        let entries = clParsed.ok ? clParsed.value : [];
        entries = await decryptChangeEntries(encKey, entries);
        if (entries.length > 0) {
          await applyRemoteEntries(entries);
        }

        await clearPendingEntries();
        await db.syncMeta.update('sync-meta', {
          lastPulledAt: Date.now(),
          lastSnapshotSha: remoteSnapshotFile.sha,
          pendingChanges: false,
        });
        lastSyncCompletedAt = Date.now();
        setDirtyFlag(false);
        reportProgress('done', 'Sync complete', 1.0);
        notifySyncSuccess();
        if (manual) toast('Initial sync complete', 'success');
        return 0;
      }
    }

    // --- Version check on remote snapshot ---
    let remoteSalt: string | undefined;
    let remoteVersion: number | undefined;
    let remoteWipedAt: number | undefined;
    if (remoteSnapshotFile) {
      const versionParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (version check)');
      if (!versionParsed.ok) {
        reportProgress('error', 'Remote data corrupted', 0);
        toast('Remote data corrupted — cannot sync', 'error');
        return -1;
      }
      const snapshotData = versionParsed.value;
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
          const snapshotData = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (wipedAt verifier)');
          if (snapshotData.ok && snapshotData.value.encryptionVerifier) {
            const ok = await checkVerifier(encKey, snapshotData.value.encryptionVerifier);
            if (!ok) {
              await db.localSettings.update('local', { encryptionPassword: undefined });
              clearEncryptionKey();
              notifyPasswordNeeded(remoteSalt);
              return -1;
            }
          }
        }

        const wipeParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (wipedAt bootstrap)');
        if (!wipeParsed.ok) {
          reportProgress('error', 'Remote data corrupted', 0);
          return -1;
        }
        let snapshot = wipeParsed.value;
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
        if (snapshot.pomodoroSettings) {
          await db.pomodoroSettings.put(snapshot.pomodoroSettings);
        }
        if (snapshot.soundPresets && snapshot.soundPresets.length > 0) {
          await db.soundPresets.clear();
          await db.soundPresets.bulkPut(snapshot.soundPresets);
        }
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
        lastSyncCompletedAt = Date.now();
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
      const verifierParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (verifier)');
      if (verifierParsed.ok && verifierParsed.value.encryptionVerifier) {
        const ok = await checkVerifier(encKey, verifierParsed.value.encryptionVerifier);
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
      const migParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'remote snapshot (migration)');
      if (!migParsed.ok) {
        reportProgress('error', 'Remote data corrupted', 0);
        return -1;
      }
      let snapshotData = migParsed.value;
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
    // Count only entries not seen in the previous sync cycle
    const previousForeignIds = new Set(
      cachedRemoteEntries.filter((e) => e.deviceId !== creds.deviceId).map((e) => e.id),
    );
    const newlyPulledCount = foreignEntries.filter((e) => !previousForeignIds.has(e.id)).length;
    if (foreignEntries.length > 0) {
      await applyRemoteEntries(foreignEntries);
    }

    // Reconcile with snapshot whenever its SHA changes to catch entities
    // absorbed by compaction while this device was offline or between syncs.
    if (remoteSnapshotFile) {
      const syncMeta = await db.syncMeta.get('sync-meta');
      if (remoteSnapshotFile.sha !== syncMeta?.lastSnapshotSha) {
        const reconParsed = safeParseJson<SyncData>(remoteSnapshotFile.data, 'snapshot (reconcile)');
        if (reconParsed.ok) {
          const snapshotData = remoteSalt
            ? await decryptSyncData(encKey, reconParsed.value)
            : reconParsed.value;
          await reconcileFromSnapshot(snapshotData);
        }
        await db.syncMeta.update('sync-meta', { lastSnapshotSha: remoteSnapshotFile.sha });
      }
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
              const freshParsed = safeParseJson<ChangeEntry[]>(fresh.data, 'remote changelog (conflict retry)');
              const freshEntries = freshParsed.ok ? freshParsed.value : [];
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
                remoteToWrite = freshToWrite;
                pushed = true;
              } catch {
                // Will loop and retry
              }
            }
            // Backoff with jitter to avoid thundering herd
            await new Promise((r) => setTimeout(r, 500 * retries + Math.random() * 500));
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
    const syncMeta = await db.syncMeta.get('sync-meta');
    await db.syncMeta.update('sync-meta', {
      lastPulledAt: Date.now(),
      lastPushedAt: pendingEntries.length > 0 ? Date.now() : undefined,
      lastSnapshotSha: remoteSnapshotFile?.sha,
      pendingChanges: remaining > 0,
    });

    // Lightweight pomodoro push: sync pomodoro data to snapshot without waiting for compaction.
    // Pomodoro settings/presets are stored as plaintext fields on the snapshot JSON,
    // so we can update them without decrypting/re-encrypting the full snapshot.
    const willCompact = !remoteSalt || (remoteEntries.length + pendingEntries.length) >= COMPACTION_THRESHOLD;
    if (!willCompact) {
      try {
        const localPomSettings = await db.pomodoroSettings.get('pomodoro');
        const localSoundPresets = await db.soundPresets.toArray();
        const pomSyncedAt = syncMeta?.pomodoroSyncedAt ?? 0;
        const pomChanged = (localPomSettings && localPomSettings.updatedAt > pomSyncedAt)
          || localSoundPresets.some(p => p.updatedAt > pomSyncedAt);

        if (pomChanged) {
          const snapFile = await getFile(creds.pat, creds.repo, SNAPSHOT_FILE);
          if (snapFile) {
            const snapJson = JSON.parse(snapFile.data);
            if (localPomSettings) snapJson.pomodoroSettings = localPomSettings;
            snapJson.soundPresets = localSoundPresets;
            try {
              await putFile(creds.pat, creds.repo, SNAPSHOT_FILE, JSON.stringify(snapJson), snapFile.sha);
              await db.syncMeta.update('sync-meta', { pomodoroSyncedAt: Date.now() });
            } catch (putErr) {
              // CONFLICT (409) is expected if another device updated snapshot concurrently — next sync retries
              if (!(putErr instanceof Error && putErr.message.includes('409'))) throw putErr;
            }
          }
        }
      } catch (pomErr) {
        // Non-critical — next sync or compaction will push pomodoro data
        console.warn('Pomodoro snapshot push failed:', pomErr);
      }
    }

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
    cachedChangelogTimestamp = Date.now();

    // Reset error backoff on success
    consecutiveErrors = 0;

    lastSyncCompletedAt = Date.now();
    setDirtyFlag(false);
    // Accumulate counts across batch cycle so the final done report includes totals
    if (batchAccum) {
      batchAccum.pulled += newlyPulledCount;
      batchAccum.pushed += pendingEntries.length;
      reportProgress('done', 'Sync complete', 1.0, batchAccum.pulled, batchAccum.pushed);
    } else {
      reportProgress('done', 'Sync complete', 1.0, newlyPulledCount, pendingEntries.length);
    }
    notifySyncSuccess();
    if (manual) toast('Sync complete', 'success');

    // Fire-and-forget: attempt backup creation (15-min gate makes this instant 99% of the time)
    maybeCreateBackups(creds.pat, creds.repo, encKey).catch(() => {});

    return remaining;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return -1;

    // Rate limit handling — pause scheduler until reset
    if (err instanceof RateLimitError) {
      const waitMs = Math.max(0, err.resetAtMs - Date.now());
      const waitMin = Math.ceil(waitMs / 60_000);
      reportProgress('error', `Rate limited — retrying in ${waitMin}m`, 0);
      toast(`Rate limited — retrying in ${waitMin}m`, 'error');
      clearSchedulerTimer();
      schedulerState = 'idle'; // pause polling
      if (rateLimitTimer) clearTimeout(rateLimitTimer);
      rateLimitTimer = setTimeout(() => {
        rateLimitTimer = null;
        if (schedulerState !== 'stopped') {
          syncNow().then(() => startIdlePoll());
        }
      }, waitMs + 1000); // 1s buffer
      return -1;
    }

    consecutiveErrors++;
    console.error('Sync failed:', err);

    // Server error backoff (5xx) — double interval, cap at 5min, throttle toasts
    const msg = err instanceof Error ? err.message : 'Sync failed';
    const isServerError = msg.includes('5');
    if (isServerError && consecutiveErrors > 1) {
      // Throttle error toasts: only show once per outage window
      if (Date.now() - lastErrorToastAt > 120_000) {
        toast('GitHub unavailable — will keep retrying', 'error');
        lastErrorToastAt = Date.now();
      }
    } else {
      toast('Sync failed', 'error');
    }

    reportProgress('error', msg, 0);
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
      const parsed = safeParseJson<SyncData>(snapshotFile.data, 'snapshot (compaction)');
      if (!parsed.ok) return; // Abort compaction on corrupted snapshot
      snapshot = parsed.value;
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

    const changelogParsed = safeParseJson<ChangeEntry[]>(changelogFile.data, 'changelog (compaction)');
    if (!changelogParsed.ok) return; // Abort compaction on corrupted changelog
    let entries = changelogParsed.value;
    if (entries.length === 0) return;
    const initialChangelogSha = changelogFile.sha;

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
          const rec = existing as unknown as Record<string, unknown>;
          rec.deletedAt = entry.timestamp;
          rec.updatedAt = entry.timestamp;
          const existingFT = rec.fieldTimestamps as Record<string, number> | undefined;
          rec.fieldTimestamps = stampUpdatedFields(existingFT, ['deletedAt'], entry.timestamp);
        }
      } else {
        const existing = map.get(entry.entityId);
        if (existing) {
          const merged = mergeEntity(
            existing as unknown as Record<string, unknown>,
            entry.data as Record<string, unknown>,
            entry.timestamp,
          );
          if (merged) {
            map.set(entry.entityId, merged as never);
          }
        } else {
          map.set(entry.entityId, entry.data as never);
        }
      }
    }

    snapshot.taskLists = Array.from(entityMaps.taskList.values());
    snapshot.tasks = Array.from(entityMaps.task.values());
    snapshot.subtasks = Array.from(entityMaps.subtask.values());

    // Cleanup soft-deletes older than 30 days
    snapshot = cleanupSoftDeletes(snapshot);

    // Auto-archive completed tasks older than 90 days
    snapshot = archiveOldCompleted(snapshot);

    // Merge local pomodoro data into snapshot (pomodoro uses snapshot-only sync)
    const localPomSettings = await db.pomodoroSettings.get('pomodoro');
    if (localPomSettings) {
      if (!snapshot.pomodoroSettings || localPomSettings.updatedAt >= (snapshot.pomodoroSettings.updatedAt ?? 0)) {
        snapshot.pomodoroSettings = localPomSettings;
      }
    }
    const localPresets = await db.soundPresets.toArray();
    if (localPresets.length > 0 || (snapshot.soundPresets && snapshot.soundPresets.length > 0)) {
      const merged = new Map<string, import('../db/models').SoundPreset>();
      // Start with remote presets
      for (const p of snapshot.soundPresets ?? []) {
        merged.set(p.id, p);
      }
      // Overlay local presets (keep whichever has newer updatedAt)
      for (const p of localPresets) {
        const existing = merged.get(p.id);
        if (!existing || p.updatedAt >= existing.updatedAt) {
          merged.set(p.id, p);
        }
      }
      snapshot.soundPresets = Array.from(merged.values());
    }

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

    // Mark pomodoro data as synced (compaction includes local pomodoro data)
    await db.syncMeta.update('sync-meta', { pomodoroSyncedAt: Date.now() });

    // Compaction lock: re-fetch changelog SHA before clearing.
    // If another device pushed entries between our read and write,
    // skip the clear to avoid losing those entries.
    // NOTE: If two devices compact simultaneously, both may write snapshots
    // with overlapping data. This is harmless — entities are keyed by ID,
    // so duplicates are idempotent. The SHA check below ensures at most one
    // device clears the changelog; the other skips, and the next compaction
    // cycle absorbs any remaining entries.
    try {
      const freshChangelog = await getFile(pat, repo, CHANGELOG_FILE);
      if (!freshChangelog || freshChangelog.sha !== initialChangelogSha) {
        // SHA changed — another device pushed entries. Skip clear; next compaction absorbs them.
        return;
      }
      await putFile(pat, repo, CHANGELOG_FILE, '[]', freshChangelog.sha);
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
      const existingParsed = safeParseJson<SyncData>(existing.data, 'existing snapshot (force push backup)');
      if (existingParsed.ok) {
        await backupRemoteSnapshot(creds.pat, creds.repo, existing.data, existingParsed.value.syncVersion ?? SYNC_VERSION);
      }
    }

    // If key is already cached (e.g. password was just changed), use it directly.
    // Otherwise resolve from remote salt + saved password.
    let encKey: CryptoKey;
    if (hasEncryptionKey()) {
      encKey = getCachedEncryptionKey()!;
    } else {
      let existingSalt: string | undefined;
      if (existing) {
        const p = safeParseJson<SyncData>(existing.data, 'existing snapshot (force push salt)');
        existingSalt = p.ok ? p.value.encryptionSalt : undefined;
      }
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
      pomodoroSyncedAt: Date.now(),
    });
    lastSyncCompletedAt = Date.now();
    reportProgress('done', 'Sync complete', 1.0);
    notifySyncSuccess();
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

    const pullParsed = safeParseJson<SyncData>(snapshotFile.data, 'remote snapshot (force pull)');
    if (!pullParsed.ok) {
      toast('Remote data corrupted', 'error');
      reportProgress('error', 'Remote data corrupted', 0);
      return;
    }
    let snapshot = pullParsed.value;

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
    if (snapshot.pomodoroSettings) {
      await db.pomodoroSettings.put(snapshot.pomodoroSettings);
    }
    if (snapshot.soundPresets && snapshot.soundPresets.length > 0) {
      await db.soundPresets.clear();
      await db.soundPresets.bulkPut(snapshot.soundPresets);
    }

    // Apply changelog entries on top
    const changelogFile = await getFile(creds.pat, creds.repo, CHANGELOG_FILE, signal);
    if (changelogFile) {
      const clParsed = safeParseJson<ChangeEntry[]>(changelogFile.data, 'changelog (force pull)');
      let entries = clParsed.ok ? clParsed.value : [];
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
    lastSyncCompletedAt = Date.now();
    reportProgress('done', 'Sync complete', 1.0);
    notifySyncSuccess();
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

      const currentPomSettings = await db.pomodoroSettings.get('pomodoro') ?? undefined;
      const currentSoundPresets = await db.soundPresets.toArray();
      let emptySnapshot: SyncData = {
        syncVersion: SYNC_VERSION,
        wipedAt: Date.now(),
        taskLists: [],
        tasks: [],
        subtasks: [],
        settings: { theme: (localStorage.getItem('gtd25-theme') as Settings['theme']) ?? 'system' },
        pomodoroSettings: currentPomSettings,
        soundPresets: currentSoundPresets,
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
    // FK validation: skip orphaned records
    const validListIds = new Set(data.taskLists.map((l) => l.id));
    const validTasks = data.tasks.filter((t) => validListIds.has(t.listId));
    const validTaskIds = new Set(validTasks.map((t) => t.id));
    const validSubtasks = data.subtasks.filter((s) => validTaskIds.has(s.taskId));

    const skippedTasks = data.tasks.length - validTasks.length;
    const skippedSubtasks = data.subtasks.length - validSubtasks.length;
    if (skippedTasks > 0 || skippedSubtasks > 0) {
      console.warn(`Import FK validation: skipped ${skippedTasks} task(s), ${skippedSubtasks} subtask(s) with broken references`);
    }

    // Replace local data
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks], async () => {
      await db.taskLists.clear();
      await db.tasks.clear();
      await db.subtasks.clear();
      await db.taskLists.bulkPut(data.taskLists);
      await db.tasks.bulkPut(validTasks);
      await db.subtasks.bulkPut(validSubtasks);
    });
    if (data.pomodoroSettings) {
      await db.pomodoroSettings.put(data.pomodoroSettings);
    }
    if (data.soundPresets && data.soundPresets.length > 0) {
      await db.soundPresets.clear();
      await db.soundPresets.bulkPut(data.soundPresets);
    }

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
        tasks: validTasks,
        subtasks: validSubtasks,
        settings: { theme },
        pomodoroSettings: data.pomodoroSettings,
        soundPresets: data.soundPresets,
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
  cachedChangelogTimestamp = 0;
  consecutiveErrors = 0;
  if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; }
  lastErrorToastAt = 0;
  lastSyncCompletedAt = 0;
  lastActivityAt = Date.now();
  batchDeadline = null;
  versionIncompatibleListeners.clear();
  syncSuccessListeners.clear();
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
    const backupParsed = safeParseJson<SyncData>(backupFile.data, 'backup file');
    if (!backupParsed.ok) {
      toast('Backup data corrupted', 'error');
      return;
    }
    let backupData = backupParsed.value;
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
    if (backupData.pomodoroSettings) {
      await db.pomodoroSettings.put(backupData.pomodoroSettings);
    }
    if (backupData.soundPresets && backupData.soundPresets.length > 0) {
      await db.soundPresets.clear();
      await db.soundPresets.bulkPut(backupData.soundPresets);
    }

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
      pomodoroSettings: backupData.pomodoroSettings,
      soundPresets: backupData.soundPresets,
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
