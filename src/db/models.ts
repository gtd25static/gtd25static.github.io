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
  fieldTimestamps?: Record<string, number>;
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
  hasWarning?: boolean;
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
  hasWarning?: boolean;
  warningAt?: number;
  blockedAt?: number;
  completedAt?: number;
  // Additional links
  links?: TaskLink[];
  fieldTimestamps?: Record<string, number>;
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
  // Periodic squash of the sync repo's default branch to bound git history growth.
  lastMainSquashAt?: number;
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
  // Paranoid Mode (device-local; not synced). Persistent record of the mode;
  // the synchronous gate flag lives in localStorage ('gtd25-paranoid').
  paranoidEnabled?: boolean;
  paranoidIdleTimeoutMinutes?: number;
  paranoidMaxUnlockAttempts?: number;   // device-local mirror of Vault.maxUnlockAttempts
  paranoidSystemIdleLock?: boolean;     // lock on system-wide idle / screen lock (IdleDetector)
  paranoidSystemLockGraceEnabled?: boolean; // device-local: defer app-lock after screen lock
  paranoidSystemLockGraceMinutes?: number;  // device-local grace duration (min) when grace enabled; default DEFAULT_SYSTEM_LOCK_GRACE_MINUTES
  // Paranoid extras — all opt-in (default off), all device-local, active only while Paranoid is on.
  paranoidPrivacyOverlayEnabled?: boolean;  // blur veil when backgrounded / half-way to auto-lock
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
  }>;
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
  dekWrappedByPass: string;       // slot 1: encryptBlob(KEK_passphrase, rawDEK)
  // Slot 2 (LUKS-style, ALWAYS present so its presence signals nothing): random
  // garbage when no duress passphrase is set, else the DEK wrapped by the duress
  // passphrase KEK (SAME passSalt+kdf as slot 1, so one derivation unwraps either).
  // Entering the duress passphrase re-keys the vault to decoy content — see db/duress.ts.
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
  remoteUnlock?: { approvers: RemoteApproverInfo[] };
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
