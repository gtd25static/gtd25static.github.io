import type { CaptureResult } from '../hooks/use-url-capture';

// Captures that reached a locked window, kept in memory only until the unlock
// files them (use-url-capture). A module of its own so the vault's re-init and
// the locked-update check can see them without importing the capture hook.

// Each one takes a click on a link somewhere; past this many, more are dropped.
const MAX_HELD = 20;
const held: CaptureResult[] = [];

export function holdCapture(capture: CaptureResult): void {
  if (held.length < MAX_HELD) held.push(capture);
}

/** Every held capture, oldest first; none are held afterwards. */
export function takeHeldCaptures(): CaptureResult[] {
  return held.splice(0);
}

export function hasHeldCaptures(): boolean {
  return held.length > 0;
}

/** Swaps each held capture for what `replace` makes of it — same number, same order. */
export function replaceHeldCaptures(replace: (capture: CaptureResult, index: number) => CaptureResult): void {
  held.splice(0, held.length, ...held.map(replace));
}
