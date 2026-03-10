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
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  description?: string;
  link?: string;
  linkTitle?: string;
  dueDate?: number;
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
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
}

export interface SyncMeta {
  id: string; // always 'sync-meta'
  remoteSha?: string;
  lastPulledAt?: number;
  lastPushedAt?: number;
  pendingChanges: boolean;
}

export interface LocalSettings {
  id: string; // always 'local'
  githubPat?: string;
  githubRepo?: string;
  syncEnabled: boolean;
  syncIntervalMs: number;
  deviceId?: string;
  encryptionPassword?: string;
}

export interface ChangeEntry {
  id: string;
  deviceId: string;
  timestamp: number;
  entityType: 'taskList' | 'task' | 'subtask';
  entityId: string;
  operation: 'upsert' | 'delete';
  data?: Record<string, unknown>;
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
}
