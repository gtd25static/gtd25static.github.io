export type ListType = 'tasks' | 'follow-ups';
export type TaskStatus = 'todo' | 'done' | 'blocked' | 'working';
export type SubtaskStatus = 'todo' | 'done' | 'blocked' | 'working';
export type PingCooldown = '12h' | '1week' | '1month' | '3months' | 'custom';

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
  archived?: boolean;
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
