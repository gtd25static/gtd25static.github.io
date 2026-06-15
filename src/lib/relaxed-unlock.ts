// "Relaxed unlock" math (pure, device-local). When the user opts in, the Paranoid
// in-app idle auto-lock and the screen-lock grace are multiplied by a factor that
// grows with how often they've had to re-unlock recently: the first unlock in the
// trailing 24h is the unavoidable baseline, and each unlock beyond it adds +10%,
// up to a hard +100% (×2). This never improves the worst case — it's bounded
// convenience the user authorizes by enabling it (see THREAT_MODEL Scenario 3).

export const RELAXED_STEP_PER_UNLOCK = 0.10; // +10% per re-unlock (beyond the first)
export const RELAXED_MAX_MULTIPLIER = 2.0;   // hard cap: never more than double
export const RELAXED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Count unlock timestamps within the trailing 24h of `now` (order-independent). */
export function unlocksInLast24h(history: number[], now: number): number {
  const cutoff = now - RELAXED_WINDOW_MS;
  let n = 0;
  for (const t of history) if (t > cutoff && t <= now) n++;
  return n;
}

/**
 * Multiplier for the idle/grace values: 1.0 + 10% per unlock BEYOND the first in
 * the last 24h, capped at ×2. So 0–1 unlocks → ×1.0 (the first just gets you in),
 * 2 → ×1.10, … , 11 or more → ×2.0.
 */
export function computeUnlockMultiplier(history: number[], now: number): number {
  const additional = Math.max(0, unlocksInLast24h(history, now) - 1);
  return Math.min(RELAXED_MAX_MULTIPLIER, 1 + RELAXED_STEP_PER_UNLOCK * additional);
}

/** Apply the multiplier to a base minute value, clamped to an absolute max. */
export function effectiveMinutes(baseMin: number, multiplier: number, absMaxMin: number): number {
  return Math.min(absMaxMin, Math.round(baseMin * multiplier));
}

/** Drop unlock timestamps outside the trailing 24h window (keeps the list small). */
export function pruneHistory(history: number[], now: number): number[] {
  const cutoff = now - RELAXED_WINDOW_MS;
  return history.filter((t) => t > cutoff && t <= now);
}
