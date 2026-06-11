// Randomized jitter for polling cadences — applied ONLY in Paranoid Mode.
//
// A fixed-interval poll (e.g. every 30s forever) is the textbook "beacon"
// signature a network monitor hunts for via timing/periodicity analysis. Adding
// ±30% jitter breaks that regularity so the sync traffic doesn't look machine-
// periodic. Non-paranoid devices keep the exact base cadence (unchanged behavior).

import { isParanoidFlagSet } from '../db/paranoid-flag';

const JITTER_FRACTION = 0.3; // ±30%

/**
 * Returns `baseMs` with ±30% randomized jitter when this device is in Paranoid
 * Mode, otherwise `baseMs` unchanged. Never returns below ~1ms.
 */
export function jitterInterval(baseMs: number): number {
  if (!isParanoidFlagSet()) return baseMs;
  const delta = baseMs * JITTER_FRACTION;
  return Math.max(1, Math.round(baseMs - delta + Math.random() * 2 * delta));
}
