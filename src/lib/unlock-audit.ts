import { db } from '../db';
import { recordError } from './diagnostics';

// Unlock audit trail (opt-in Paranoid extra): a device-local, never-synced log
// of unlock attempts, so a returning user can spot activity in their absence
// ("last unlock yesterday 23:14 · 2 failed attempts since"). Same plaintext
// class as the existing failedUnlockAttempts / unlockHistory counters.
//
// A duress unlock (see duress.ts) is logged as a plain 'passphrase' success —
// this log must NEVER be able to give the decoy away.

export const MAX_UNLOCK_LOG = 50;

export type UnlockMethod = 'passphrase' | 'securityKey' | 'remote';

export interface UnlockLogEntry {
  at: number;
  method: UnlockMethod;
  ok: boolean;
}

/** Append an unlock attempt to the log, capped and best-effort. No-op unless the
 *  feature is enabled — reads the toggle itself so callers stay simple. */
export async function recordUnlockAttempt(method: UnlockMethod, ok: boolean, at: number): Promise<void> {
  try {
    const local = await db.localSettings.get('local');
    if (!local?.paranoidUnlockLogEnabled) return;
    const log = [...(local.unlockLog ?? []), { at, method, ok }].slice(-MAX_UNLOCK_LOG);
    await db.localSettings.update('local', { unlockLog: log });
  } catch (err) {
    // Telemetry must never break an unlock.
    recordError('vault.recordUnlockAttempt', err);
  }
}

export async function clearUnlockLog(): Promise<void> {
  await db.localSettings.update('local', { unlockLog: [] });
}

/**
 * The failed attempts since the most recent successful unlock, oldest first —
 * what the returning-user alert lists so each one can be judged by its time and
 * method (your own typo a minute ago reads very differently from 03:14 last night).
 */
export function failedEntriesSinceLastSuccess(log: UnlockLogEntry[]): UnlockLogEntry[] {
  const failed: UnlockLogEntry[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].ok) break;
    failed.push(log[i]);
  }
  return failed.reverse();
}

/** The most recent successful unlock strictly before the last entry (i.e. the previous session). */
export function previousSuccess(log: UnlockLogEntry[]): UnlockLogEntry | null {
  const successes = log.filter((e) => e.ok);
  // The last success is the unlock that just happened; the one before it is "last time".
  return successes.length >= 2 ? successes[successes.length - 2] : null;
}
