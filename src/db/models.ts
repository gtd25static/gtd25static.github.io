import type { KdfParams } from './vault-kdf';
import type { DeviceIdentity } from '../sync/remote-unlock-crypto';

export type ListType = 'tasks' | 'follow-ups';
// 'working' was removed 2026-06 (superseded by Focus Mode); legacy rows are
// normalized to 'todo' by the SYNC_VERSION 4->5 migrations.
export type TaskStatus = 'todo' | 'done' | 'blocked';
export type SubtaskStatus = 'todo' | 'done' | 'blocked';
// Current UI presets: '20h' | '6d' | '30d' | '12w'. Legacy values
// ('12h' | '1week' | '1month' | '3months') are kept so already-snoozed tasks
// still type-check and resolve a cooldown. 'custom' = absolute pingCooldownUntil.
export type PingCooldown =
  | '20h'
  | '6d'
  | '30d'
  | '12w'
  | '12h'
  | '1week'
  | '1month'
  | '3months'
  | 'custom';

export interface TaskList {
  id: string;
  name: string;
  type: ListType;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  // When the list was archived (absent = active). Archived lists move to the
  // collapsed section at the end of the sidebar, stop feeding Focus/nudges/
  // banners/counters, and are soft-deleted into the Trash once they are older
  // than ARCHIVED_LIST_RETENTION_MS. Plaintext metadata (a timestamp, like
  // deletedAt) — NOT in SENSITIVE_FIELDS.taskList.
  archivedAt?: number;
  // The list's saved quick-filter searches, shown as chips (oldest first). What
  // someone searches for is content: SENSITIVE (encrypted on the wire and at
  // rest), merged as a whole (LWW). Untrusted on read — see lib/list-filter.ts.
  savedSearches?: string[];
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

export interface TaskLink {
  url: string;
  title?: string;
}

// A single recorded discussion of a follow-up topic. Free-text `note` is
// sensitive content (encrypted in sync + at-rest); see SENSITIVE_FIELDS.task.
export interface DiscussionEntry {
  id: string;
  at: number; // when the topic was discussed
  note?: string; // optional outcome / what was said
  // When the note was settled after two devices edited it at once (sync/conflicts.ts).
  editedAt?: number;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  description?: string;
  link?: string;
  linkTitle?: string;
  dueDate?: number;
  starred?: boolean;
  status: TaskStatus;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  // Follow-up fields
  pingedAt?: number;
  pingCooldown?: PingCooldown;
  pingCooldownCustomMs?: number;
  pingCooldownUntil?: number;
  archived?: boolean;
  // Follow-up: per-topic default snooze cadence, used by the one-tap "Discussed"
  // re-snooze. Plaintext metadata (no user content). 'custom' => snoozeCadenceDays.
  snoozeCadence?: PingCooldown;
  snoozeCadenceDays?: number;
  // Follow-up: discussion history (oldest-first). SENSITIVE — encrypted as a unit.
  discussionLog?: DiscussionEntry[];
  // Warning
  // Stored as 1 — booleans aren't valid IndexedDB keys, so `true` never reached
  // the hasWarning index. Older rows/devices may still say `true` (normalised on
  // write, see db/warning-index.ts); read it as a truthy flag.
  hasWarning?: 1 | true;
  warningAt?: number;
  blockedAt?: number;
  completedAt?: number;
  // Work tracking
  workedAt?: number;
  // Focus Mode membership: when this task entered the focus set. Plaintext
  // metadata (timestamp only, like workedAt) — synced, NOT in SENSITIVE_FIELDS.
  // Cleared by the daily focus cleanup, by recurring reset, or on trim (the
  // trim runs both daily and continuously — see maintainFocusSet).
  // NOTE: kept on done tasks until the next daily cleanup so the Focus view's
  // "cleared N today" count works AND the slot stays held against the
  // continuous top-up — don't clear it on completion.
  focusedAt?: number;
  // Additional links
  links?: TaskLink[];
  // Recurrence
  recurrenceType?: 'time-based' | 'date-based';
  recurrenceInterval?: number;
  recurrenceUnit?: 'hours' | 'days' | 'weeks' | 'months';
  lastCompletedAt?: number;
  nextOccurrence?: number;
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  link?: string;
  linkTitle?: string;
  dueDate?: number;
  status: SubtaskStatus;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  // Warning
  // Stored as 1 — booleans aren't valid IndexedDB keys, so `true` never reached
  // the hasWarning index. Older rows/devices may still say `true` (normalised on
  // write, see db/warning-index.ts); read it as a truthy flag.
  hasWarning?: 1 | true;
  warningAt?: number;
  blockedAt?: number;
  completedAt?: number;
  // Additional links
  links?: TaskLink[];
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

export type SharedItemType = 'link' | 'file' | 'snippet';

// An item in the single app-level Shared Folder, synced across the user's own
// devices. Metadata (type/name/size/url/blobId/mimeType) is SENSITIVE and
// encrypted as a unit on the wire and at rest (see SENSITIVE_FIELDS.sharedItem);
// only opaque id/order/timestamps stay plaintext — same exposure level as tasks.
// File/snippet bytes live in a separate opaque backend blob (gtd25-shared/{blobId});
// link URLs live inline in `url`. blobId is encrypted so a backend observer can't
// correlate a metadata entry to its blob object.
export interface SharedItem {
  id: string;
  type: SharedItemType;
  name: string;        // filename / link title / snippet title
  size: number;        // bytes, counted against the folder quota
  url?: string;        // link only
  blobId?: string;     // file/snippet: opaque ref to backend blob
  mimeType?: string;   // file/snippet
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

// Mindmaps: hierarchical node diagrams organized in nested folders. All three
// entities sync like tasks (changelog + field-level LWW). Only `name`/`label`
// are SENSITIVE (encrypted on the wire and at rest); structural refs
// (parentId/folderId/mapId) and order/timestamps stay plaintext so devices can
// merge structure without decrypting — same exposure level as Task.listId.

export interface MindmapFolder {
  id: string;
  name: string;
  parentId?: string; // absent = top level of the folder tree
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

export interface Mindmap {
  id: string;
  name: string;
  folderId?: string; // absent = top level
  /** Canvas background, '#rrggbb'. Absent = the theme's surface. SENSITIVE. */
  background?: string;
  /** "Smart colouring" mode: new branches auto-get a distinct colour. SENSITIVE. */
  smartColoring?: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

// A single node of a mindmap. The map's root is the node with no parentId;
// tree-building resolves anomalies (two roots, cycles from concurrent
// reparents) deterministically — see src/lib/mindmap-tree.ts.
export type MindmapNodeShape = 'rect' | 'circle' | 'diamond';

export interface MindmapNode {
  id: string;
  mapId: string;
  parentId?: string; // absent = THE root node of the map
  order: number;     // sibling order
  label: string;     // 1..1000 chars, markdown subset — SENSITIVE
  // Formatting, all optional (absent = the theme's default look). SENSITIVE:
  // a colour scheme is content (red = blocked, green = done). Validated on the
  // way in and on render — see lib/mindmap-style.ts.
  shape?: MindmapNodeShape;
  palette?: string;      // preset id from PALETTES; unknown ids fall back to the default
  colorBg?: string;      // '#rrggbb' override of the preset's background
  colorFg?: string;      // '#rrggbb' override of the preset's text colour
  colorBorder?: string;  // '#rrggbb' override of the preset's border
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  fieldTimestamps?: Record<string, number>;
  // Local only: per field, the newest timestamp known to be on the remote
  // (sync/conflicts.ts). Rides in this device's change entries as their base.
  _base?: Record<string, number>;
  // Local only: per field, the newest timestamp this device has pushed.
  _pushed?: Record<string, number>;
}

// Device-local cache of a Shared Folder blob's bytes (NEVER synced). `data` holds
// plaintext bytes when Paranoid Mode is off, and DEK-encrypted bytes when it's on
// (applied explicitly by shared-blobs.ts since the field-oriented vault middleware
// can't handle binary). Decrypted to memory only when an item is opened.
export interface SharedBlob {
  id: string; // = SharedItem.blobId
  data: Uint8Array;
  cachedAt: number;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
}

export interface SyncMeta {
  id: string; // always 'sync-meta'
  remoteSha?: string;
  lastSnapshotSha?: string;
  lastPulledAt?: number;
  lastPushedAt?: number;
  pendingChanges: boolean;
  pomodoroSyncedAt?: number;
  // Shared Folder blob-branch history compaction (local bookkeeping, not synced):
  // count of blob deletions on this device since the last compaction, and when we
  // last compacted. Gate `maybeCompactBlobBranch`. See src/sync/shared-blobs.ts.
  pendingBlobDeletes?: number;
  lastBlobCompactionAt?: number;
  // When a compaction last failed (e.g. force pushes refused): not retried on
  // every sync. The one-time squash of the history an older version's
  // file-by-file deletes left. And blobs on the branch no item here names, by
  // when each was first seen — another device's upload whose metadata has not
  // arrived — dropped as garbage only after a week.
  blobCompactionFailedAt?: number;
  blobHistorySweptAt?: number;
  unknownBlobsSeenAt?: Record<string, number>;
  // Periodic squash of the sync repo's default branch to bound git history growth.
  lastMainSquashAt?: number;
  // Set before this device's first upload to an empty repo, cleared when it
  // completes: an upload cut between its snapshot and its changelog is finished
  // by the next sync instead of being refused as an incomplete remote.
  initialUploadAt?: number;
  initialUploadRepo?: string;
  // When this device started recording `_base` (sync/conflicts.ts): a row
  // without one takes its field timestamps up to here as its base.
  conflictBaseSince?: number;
  // A wipe's purge of every Shared Folder file's bytes is still to do (set before
  // the wipe's first remote write; compaction then drops every file, no grace).
  blobPurgeAll?: boolean;
  // When that squash last failed: retried once a day, not after every sync.
  mainSquashFailedAt?: number;
  // A sync-password change in progress (see sync/key-rotation.ts): the new salt
  // and a verifier of the new key, pinned so a retry rotates to the same key and
  // refuses a different password. Cleared when the rotation completes.
  keyRotation?: { newSalt: string; newVerifier: string; startedAt: number };
  // The `wipedAt` of the last wipe / import / backup restore this device adopted
  // (or performed). A reset is adopted once, by identity: comparing it with
  // lastPulledAt alone mixes two devices' clocks, and a device running behind
  // would re-adopt it on every sync, discarding its own edits each time.
  lastWipeSeenAt?: number;
  // The repository this device has seen encrypted (opened with a verified key).
  // That repository showing up without a salt was stripped by whoever can write
  // it — taking it for a first encryption used to destroy the content.
  encryptedRepo?: string;
  // The highest syncVersion this device has seen on the remote. It only ever goes
  // up; lower means someone lowered it (to let an older build in, which would
  // write newer encrypted fields back in the clear).
  maxSyncVersionSeen?: number;
}

/**
 * Per-weekday override on the global nudge window, keyed in
 * `LocalSettings.nudgeDayOverrides` by `Date.getDay()` (0=Sun..6=Sat).
 */
export interface NudgeDayOverride {
  off?: boolean; // silence this weekday entirely
  end?: number;  // earlier end hour (0–23) for this weekday; start stays the global window start
}

export interface LocalSettings {
  id: string; // always 'local'
  githubPat?: string;
  githubRepo?: string;
  syncEnabled: boolean;
  syncIntervalMs: number;
  deviceId?: string;
  encryptionPassword?: string;
  // The sync password and salt from before an unfinished sync-password change
  // (sync/key-rotation.ts): a retry after its commit point needs the old key.
  // Kept only until the change completes or is forgotten; in the vault instead
  // when Paranoid Mode is on.
  previousEncryptionPassword?: string;
  previousEncryptionSalt?: string;
  appliedSyncVersion?: number;
  changelogPruned?: boolean;
  // Nudge notifications (device-local; not synced)
  nudgesEnabled?: boolean;
  nudgeIntervalHours?: number;
  nudgeWindowStart?: number; // hour 0–23
  nudgeWindowEnd?: number;   // hour 0–23
  // Per-weekday overrides on the window above, keyed by Date.getDay() (0=Sun..6=Sat):
  // silence a day (off) or give it an earlier end hour. Absent ⇒ global window applies.
  nudgeDayOverrides?: Record<number, NudgeDayOverride>;
  nudgeSoundEnabled?: boolean;
  lastNudgeAt?: number;
  lastFocusRefillDay?: string; // local 'YYYY-MM-DD' of the last Focus Mode refill (device-local)
  // When a record arrived here already deleted by sync, by id (device-local; ids
  // and times only). The 30-day Trash window runs from the later of that and its
  // deletedAt, so a delete back-dated by whoever can write the repo is not
  // purged at the next start. Entries go when the record is purged or restored.
  trashArrivals?: Record<string, number>;
  // When this device last rewrote its stored rows that were not plain at-rest
  // ciphertext (db/vault-migration rewriteLegacyAtRestRows) — once per device.
  atRestRewrittenAt?: number;
  // Paranoid Mode (device-local; not synced). Persistent record of the mode;
  // the synchronous gate flag lives in localStorage ('gtd25-paranoid').
  paranoidEnabled?: boolean;
  paranoidIdleTimeoutMinutes?: number;
  paranoidMaxUnlockAttempts?: number;   // device-local mirror of Vault.maxUnlockAttempts
  // Set once when an unlock armed the attempt wipe on a vault that predates the
  // setting (the UI had been showing it armed while the vault had it disabled).
  // Settings clears it after telling the user.
  paranoidAttemptWipeArmedNotice?: boolean;
  paranoidSystemIdleLock?: boolean;     // lock on system-wide idle / screen lock (IdleDetector)
  // Set when the detector could not actually be started, so Settings stops
  // showing the toggle as protection the device is not providing.
  paranoidSystemIdleUnavailable?: boolean;
  paranoidSystemLockGraceEnabled?: boolean; // device-local: defer app-lock after screen lock
  paranoidSystemLockGraceMinutes?: number;  // device-local grace duration (min) when grace enabled; default DEFAULT_SYSTEM_LOCK_GRACE_MINUTES
  // Paranoid extras — all opt-in (default off), all device-local, active only while Paranoid is on.
  paranoidPrivacyOverlayEnabled?: boolean;  // blur veil after half the time left to auto-lock, in the background
  paranoidPrivacyOverlayImmediate?: boolean; // ...or the instant it backgrounds (blanks task-switcher previews)
  paranoidBackgroundLockEnabled?: boolean;  // lock the vault after the tab has been hidden N seconds
  paranoidBackgroundLockSeconds?: number;   // 0 = the instant it hides; clamped 0-300, default 30
  paranoidLockHotkeyEnabled?: boolean;      // Ctrl/Cmd+Shift+L locks the vault instantly
  paranoidRedactModeEnabled?: boolean;      // offer the shoulder-surfing redact toggle (Ctrl/Cmd+Shift+H)
  paranoidUnlockLogEnabled?: boolean;       // keep a device-local unlock/attempt audit trail
  unlockLog?: import('../lib/unlock-audit').UnlockLogEntry[]; // capped at MAX_UNLOCK_LOG; never synced
  paranoidClipboardClearEnabled?: boolean;  // wipe the clipboard N seconds after copying app content
  paranoidClipboardClearSeconds?: number;   // clamped 10-300, default 60
  // "Relaxed unlock" (device-local; not synced): stretch idle/grace by +10% per
  // re-unlock in the last 36h (first unlock excluded), capped ×2. unlockHistory is
  // unlock timestamps pruned to 36h, recorded only while the feature is enabled.
  relaxedUnlockEnabled?: boolean;
  unlockHistory?: number[];
  // Remote unlock & wipe (device-local; not synced as-is). This device's long-term
  // identity keypairs (P-256). Plaintext: the ECDSA private key must sign unlock
  // requests while the vault is LOCKED, and it unlocks nothing on its own.
  deviceIdentity?: DeviceIdentity;
  deviceName?: string;                  // friendly name shown to approvers
  // Approver side: this (Paranoid-OFF) device can approve/wipe these protected
  // devices. RUK + the protected device's verify key + name, keyed by its deviceId.
  remoteApproverFor?: Record<string, {
    ruk: string;
    ecdsaPub: JsonWebKey;
    name: string;
    lastWipeCommand?: { nonce: string; sentAt: number };
    lastWipeAck?: { commandNonce: string; wipedAt: number; verifiedAt: number };
    // When the protected device last refreshed its (MAC-verified) registry entry,
    // i.e. was last unlocked with sync — shown as "last seen" / "no activity since".
    lastSeenAt?: number;
    // Timestamp of the invite this RUK came from. A re-issued invite (the
    // protected device rotated its key after removing another approver) is only
    // accepted when it is NEWER, so a replayed old invite cannot push this
    // device back to a stale key. Absent on entries stored before rotation
    // existed, which read as 0 and accept the first re-issue.
    acceptedTs?: number;
    // When this device last declined an unlock request from that device: a
    // request you did not expect means its key is likely out (see Settings).
    lastDeniedAt?: number;
  }>;
  // When an unlock found the sealed approver list (Vault.remoteUnlock.seal) did
  // not match the one on disk — remote unlock was turned off then (Settings says so).
  remoteUnlockTampered?: number;
}

// A protected device's enrolled approver (public info cached locally so the
// locked device can target it and verify its signed responses without the registry).
export interface RemoteApproverInfo {
  deviceId: string;
  name: string;
  ecdhPub: JsonWebKey;
  ecdsaPub: JsonWebKey;
}

// One enrolled FIDO2/PRF authenticator (a YubiKey, or a phone over hybrid
// transport). Each credential wraps the same DEK with its own PRF-derived KEK,
// so ANY enrolled authenticator can unlock. All share the vault's single
// `prfSalt` (a credential's PRF over that salt is still unique per credential).
export interface PrfCredential {
  credentialId: string;                  // base64 rawId, for allowCredentials
  dekWrappedByPrf: string;               // encryptBlob(KEK_this-key-prf, rawDEK)
  label?: string;                        // user-facing, e.g. "YubiKey", "Pixel"
  addedAt: number;
  transports?: AuthenticatorTransport[]; // hints allowCredentials routing (e.g. 'hybrid')
}

// Paranoid Mode vault (device-local, NEVER synced or exported). Holds the
// wrapped data-encryption key (DEK) and at-rest-encrypted secrets. Single row
// with id='vault'. See src/db/vault.ts.
export interface Vault {
  id: string; // always 'vault'
  // Every wrap below is AES-GCM under its KEK, bound to its slot as additional
  // data (see db/vault-crypto.ts), so a wrap moved to another slot won't open.
  dekWrappedByPass: string;       // slot 1: the DEK wrapped by the passphrase KEK
  // Slot 2 (LUKS-style, ALWAYS present so its presence signals nothing): random
  // garbage when no duress passphrase is set, else the DEK wrapped by the duress
  // passphrase KEK (SAME passSalt+kdf as slot 1, so one derivation unwraps either).
  // Entering the duress passphrase re-keys the vault to decoy content — see db/vault-reinit.ts.
  wrappedDek2?: string;
  passSalt: string;               // salt for the passphrase KEK (both slots)
  // How the passphrase KEK is derived. Absent => legacy PBKDF2 (pre-Argon2id);
  // such vaults still unlock and are re-wrapped to Argon2id on next unlock.
  kdf?: KdfParams;
  // Enrolled security keys (any one unlocks). Absent on pre-multi-key vaults,
  // which still carry the single legacy dekWrappedByPrf/webauthnCredentialId
  // below; vault.ts normalizes those into this array on first read/write.
  securityKeys?: PrfCredential[];
  dekWrappedByPrf?: string;       // LEGACY single credential (pre-multi-key)
  webauthnCredentialId?: string;  // LEGACY base64 credential id (pre-multi-key)
  prfSalt?: string;               // salt fed to the WebAuthn PRF extension
  verifier: string;               // encryptBlob(DEK, VERIFIER_PLAINTEXT)
  secrets?: string;               // encryptBlob(DEK, JSON({githubPat, syncPassword}))
  idleTimeoutMinutes: number;     // re-lock after this much inactivity
  // Brute-force tripwire for the at-keyboard path: wipe local data after this many
  // consecutive failed passphrase unlocks (0 = disabled). Persisted so a reload
  // can't reset the count.
  maxUnlockAttempts?: number;
  failedUnlockAttempts?: number;
  migrationState?: 'encrypting' | 'decrypting' | 'done';
  // Remote unlock: DEK wrapped by a random remote-unlock key (RUK) held by trusted
  // approver devices; present only when remote unlock is enrolled.
  dekWrappedByRuk?: string;
  // RUK wrapped by the DEK, so an unlocked device can recover RUK to enrol ADDITIONAL
  // approvers without re-keying the existing ones. No new at-rest exposure: recovering
  // RUK still requires the DEK (i.e. an unlocked vault).
  rukWrappedByDek?: string;
  // A new RUK staged beside the current one while it is handed to the approvers
  // (removing an approver, a re-issue): it opens the vault too, so an approver
  // that already got it can unlock if the hand-out is interrupted. Promoted into
  // dekWrappedByRuk once every approver has it; cleared with remote unlock.
  dekWrappedByRukNext?: string;
  rukNextWrappedByDek?: string;
  // `seal`: the approver list encrypted under the DEK. The list itself must stay
  // readable while locked (the lock screen encrypts requests to these keys), so
  // a disk writer could swap a key; the seal catches that at the next unlock.
  remoteUnlock?: { approvers: RemoteApproverInfo[]; seal?: string };
}

/**
 * The same field of the same item changed on two devices that had not seen each
 * other's change (sync/conflicts.ts). Kept on this device only, until the user
 * picks a version (or a later edit supersedes both); the newer version is
 * applied meanwhile, as before. `localValue` / `remoteValue` / `label` are
 * content — encrypted at rest in Paranoid Mode.
 */
export interface SyncConflict {
  /** entityType:entityId:field:localAt:remoteAt — the same conflict is recorded once. */
  id: string;
  entityType: 'taskList' | 'task' | 'subtask' | 'mindmapFolder' | 'mindmap' | 'mindmapNode';
  entityId: string;
  /** The field, `discussionLog:<entry id>` for one discussion note, or '' for a delete-vs-edit. */
  field: string;
  kind: 'field' | 'deleted-remotely' | 'deleted-locally';
  localValue?: unknown;
  remoteValue?: unknown;
  localAt: number;
  remoteAt: number;
  /** Which version is applied meanwhile. */
  applied: 'local' | 'remote';
  /** The item's title or name when detected, for the list. */
  label?: string;
  detectedAt: number;
}

export interface ChangeEntry {
  id: string;
  deviceId: string;
  timestamp: number;
  entityType: 'taskList' | 'task' | 'subtask' | 'sharedItem' | 'mindmapFolder' | 'mindmap' | 'mindmapNode';
  entityId: string;
  operation: 'upsert' | 'delete';
  data?: Record<string, unknown>;
  v?: number;
}

export interface SyncData {
  syncVersion?: number;
  wipedAt?: number;
  // Written with wipedAt by a wipe / import / restore: the ids of the changelog
  // entries that reset replaced. Wherever they are still found — a changelog
  // reset that failed, a device that read the changelog before it — they are
  // ignored; they used to be replayed over the reset on every device.
  supersededEntryIds?: string[];
  encryptionSalt?: string;
  encryptionVerifier?: string;
  taskLists: TaskList[];
  tasks: Task[];
  subtasks: Subtask[];
  sharedItems?: SharedItem[];
  mindmapFolders?: MindmapFolder[];
  mindmaps?: Mindmap[];
  mindmapNodes?: MindmapNode[];
  settings: Settings;
  pomodoroSettings?: PomodoroSettings;
  soundPresets?: SoundPreset[];
}

// Pomodoro types
export interface PomodoroSound {
  id: string;         // e.g. "aa", "ticking-fast", "alarm-kitchen"
  blob: Blob;
  importedAt: number;
}

export type SoundVolumeLevel = 'off' | 'low' | 'medium' | 'high';

export interface SoundPreset {
  id: string;
  name: string;
  sounds: Record<string, SoundVolumeLevel>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface PomodoroSettings {
  id: string;           // always 'pomodoro'
  masterVolume: number; // 0–1
  tickingEnabled: boolean;
  bellEnabled: boolean;
  activePresetId: string | null;
  updatedAt: number;
  dynamicMixEnabled: boolean;
}
