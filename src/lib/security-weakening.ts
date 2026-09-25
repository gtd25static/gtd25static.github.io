import type { LocalSettings } from '../db/models';
import { DEFAULT_BACKGROUND_LOCK_SECONDS } from '../hooks/use-background-lock';
import { DEFAULT_SYSTEM_LOCK_GRACE_MINUTES } from './system-idle';
import { DEFAULT_CLIPBOARD_CLEAR_SECONDS } from './clipboard-hygiene';

// Which Paranoid settings changes LOOSEN the device's protection. The settings
// ask for the passphrase before applying one (an unlocked but unattended session
// must not be enough to switch protections off), and never before tightening.

/** Protections: switching one OFF loosens. */
const PROTECTIONS = [
  'paranoidSystemIdleLock',
  'paranoidPrivacyOverlayEnabled',
  'paranoidPrivacyOverlayImmediate',
  'paranoidBackgroundLockEnabled',
  'paranoidLockHotkeyEnabled',
  'paranoidRedactModeEnabled',
  'paranoidUnlockLogEnabled',
  'paranoidClipboardClearEnabled',
] as const satisfies ReadonlyArray<keyof LocalSettings>;

/** Relaxations: switching one ON loosens. */
const RELAXATIONS = [
  'paranoidSystemLockGraceEnabled',
  'relaxedUnlockEnabled',
] as const satisfies ReadonlyArray<keyof LocalSettings>;

/** Delays before a protection acts: a LONGER one loosens (unset = the default). */
const DELAYS = {
  paranoidBackgroundLockSeconds: DEFAULT_BACKGROUND_LOCK_SECONDS,
  paranoidSystemLockGraceMinutes: DEFAULT_SYSTEM_LOCK_GRACE_MINUTES,
  paranoidClipboardClearSeconds: DEFAULT_CLIPBOARD_CLEAR_SECONDS,
} as const satisfies Partial<Record<keyof LocalSettings, number>>;

/** Whether applying `changes` to `current` loosens any protection. */
export function weakensProtection(current: LocalSettings, changes: Partial<LocalSettings>): boolean {
  for (const key of PROTECTIONS) {
    if (key in changes && !!current[key] && !changes[key]) return true;
  }
  for (const key of RELAXATIONS) {
    if (key in changes && !current[key] && !!changes[key]) return true;
  }
  for (const [key, fallback] of Object.entries(DELAYS) as Array<[keyof typeof DELAYS, number]>) {
    const next = changes[key];
    if (typeof next === 'number' && next > (current[key] ?? fallback)) return true;
  }
  return false;
}
