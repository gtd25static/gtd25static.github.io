import { db } from '../db';
import { isParanoidEnabled } from '../db/vault';
import { recordError } from './diagnostics';

// Clipboard auto-clear (opt-in Paranoid extra): after copying app content, wipe
// the clipboard once the configured delay elapses, so a copied outline / PNG /
// diagnostics blob doesn't sit there indefinitely for the next app that reads it.
//
// Honest limits (documented in the UI + THREAT_MODEL):
//  - Cannot touch OS clipboard *managers / history* (Windows Win+V, macOS
//    third-party managers) — only the live clipboard.
//  - The Clipboard API requires document focus to WRITE; if focus is elsewhere
//    when the timer fires, we retry once on the next focus.
//  - Verifying the clipboard still holds *our* content needs clipboard-read
//    permission, which we never prompt for. If it's already granted we check and
//    skip the wipe when the user has since copied something else; otherwise we
//    clear unconditionally (Bitwarden-style) once the delay is up.

export const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 60;

/** Clamp the delay to [10, 300] s. */
export function clampClipboardClearSeconds(value: string | number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  return Math.max(10, Math.min(300, Math.floor(n)));
}

interface ClearSettings { enabled: boolean; seconds: number }

async function readSettings(): Promise<ClearSettings> {
  const local = await db.localSettings.get('local');
  return {
    enabled: !!local?.paranoidClipboardClearEnabled,
    seconds: clampClipboardClearSeconds(local?.paranoidClipboardClearSeconds ?? DEFAULT_CLIPBOARD_CLEAR_SECONDS),
  };
}

// A rolling token: only the most recent copy's scheduled clear should run, so a
// second copy resets the countdown rather than wiping the fresh content early.
let clearToken = 0;

/**
 * Copy text, then (Paranoid + toggle on) schedule the auto-clear. Returns the
 * clipboard write result so callers keep their existing success/failure UX.
 */
export async function writeTextWithHygiene(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  void scheduleClear(text);
}

/** Copy an image/blob via ClipboardItem, then schedule the auto-clear. */
export async function writeClipboardItemWithHygiene(items: ClipboardItem[]): Promise<void> {
  await navigator.clipboard.write(items);
  // We can't cheaply read image content back to compare, so an image clear is
  // always unconditional (null = "don't compare").
  void scheduleClear(null);
}

async function scheduleClear(expected: string | null): Promise<void> {
  if (!isParanoidEnabled()) return;
  const { enabled, seconds } = await readSettings();
  if (!enabled) return;
  const token = ++clearToken;
  setTimeout(() => { void runClear(token, expected); }, seconds * 1000);
}

async function runClear(token: number, expected: string | null): Promise<void> {
  if (token !== clearToken) return; // a newer copy superseded this one
  try {
    // If we can read without prompting AND we know what we wrote, only clear
    // when the clipboard still holds it — don't stomp on the user's later copy.
    if (expected !== null && (await hasReadPermission())) {
      let current: string;
      try {
        current = await navigator.clipboard.readText();
      } catch {
        current = expected; // read blocked despite the grant — fall through to clear
      }
      if (current !== expected) return;
    }
    await clearNow(token);
  } catch (err) {
    recordError('clipboard.autoClear', err);
  }
}

async function clearNow(token: number): Promise<void> {
  if (!document.hasFocus()) {
    // The API needs focus to write; retry once when focus returns.
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      if (token === clearToken) void navigator.clipboard.writeText('').catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return;
  }
  await navigator.clipboard.writeText('');
}

async function hasReadPermission(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false; // not queryable (Firefox/Safari) — never prompt, treat as no
  }
}

/** Reset the rolling token between tests. */
export function __resetClipboardHygieneForTests(): void {
  clearToken = 0;
}
