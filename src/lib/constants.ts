declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

export const DUE_SOON_DAYS = 10;
export const SOFT_DELETE_CLEANUP_DAYS = 30;
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;

export const PING_COOLDOWN_MS: Record<string, number> = {
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
