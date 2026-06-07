import type { KdfParams } from './vault-kdf';

export type ListType = 'tasks' | 'follow-ups';
export type TaskStatus = 'todo' | 'done' | 'blocked' | 'working';
export type SubtaskStatus = 'todo' | 'done' | 'blocked' | 'working';
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
  nudgeSoundEnabled?: boolean;
  lastNudgeAt?: number;
  // Paranoid Mode (device-local; not synced). Persistent record of the mode;
  // the synchronous gate flag lives in localStorage ('gtd25-paranoid').
  paranoidEnabled?: boolean;
  paranoidIdleTimeoutMinutes?: number;
  paranoidMaxUnlockAttempts?: number;   // device-local mirror of Vault.maxUnlockAttempts
  paranoidSystemIdleLock?: boolean;     // lock on system-wide idle / screen lock (IdleDetector)
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
  dekWrappedByPass: string;       // encryptBlob(KEK_passphrase, rawDEK)
  passSalt: string;               // salt for the passphrase KEK
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
}

export interface ChangeEntry {
  id: string;
  deviceId: string;
  timestamp: number;
  entityType: 'taskList' | 'task' | 'subtask';
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
