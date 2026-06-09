declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const GIT_COMMIT: string = typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'dev';

export const DUE_SOON_DAYS = 14;
export const SORT_DUE_SOON_DAYS = 7;
export const SOFT_DELETE_CLEANUP_DAYS = 30;
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;

// Input length limits
export const MAX_TITLE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_LIST_NAME_LENGTH = 100;

// Shared Folder overall storage cap (30 MB). Per-item cap = remaining free space.
export const MAX_SHARED_FOLDER_BYTES = 30 * 1024 * 1024;

export const INBOX_LIST_NAME = 'Inbox';

export function isInboxList(list: { name: string; type: string }): boolean {
  return list.name === INBOX_LIST_NAME && list.type === 'tasks';
}

export const PING_COOLDOWN_MS: Record<string, number> = {
  // Current presets surfaced in the UI
  '20h': 20 * 60 * 60 * 1000,
  '6d': 6 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '12w': 12 * 7 * 24 * 60 * 60 * 1000,
  // Legacy presets — kept so already-snoozed tasks still resolve a cooldown
  '12h': 12 * 60 * 60 * 1000,
  '1week': 7 * 24 * 60 * 60 * 1000,
  '1month': 30 * 24 * 60 * 60 * 1000,
  '3months': 90 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_KEYBOARD_SHORTCUTS: Record<string, string> = {
  navigateDown: 'j',
  navigateUp: 'k',
  navigateLeft: 'h',
  navigateRight: 'l',
  expand: 'Enter',
  startWorking: 'Ctrl+Enter',
  editTitle: 'Space',
  addSubtask: 'Tab',
  collapse: 'Escape',
  newTask: 'n',
  markDone: 'd',
  markBlocked: 'b',
  workOn: 'w',
  help: '?',
  search: '/',
};
