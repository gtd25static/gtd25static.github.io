import type { CaptureResult } from '../hooks/use-url-capture';

// Captures kept in memory only: those that reached a locked window (the unlock
// files them) and, in Paranoid Mode, those waiting for the user to confirm
// them (CaptureConfirmPrompt). A module of its own so the vault's re-init and
// the locked-update check can see them without importing the capture hook.

export interface HeldCapture {
  id: number;
  capture: CaptureResult;
  /** Waits for the user's confirmation instead of being filed by the unlock. */
  ask: boolean;
}

// Each one takes a click on a link somewhere; past this many, more are dropped.
const MAX_HELD = 20;
let held: HeldCapture[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
// Bumped on every change, for useSyncExternalStore.
let version = 0;

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

export function holdCapture(capture: CaptureResult, ask = false): void {
  if (held.length >= MAX_HELD) return;
  held.push({ id: nextId++, capture, ask });
  changed();
}

/** The held captures that need no confirmation, oldest first; they are no longer held. */
export function takeCapturesToFile(): CaptureResult[] {
  const toFile = held.filter((h) => !h.ask);
  if (toFile.length === 0) return [];
  held = held.filter((h) => h.ask);
  changed();
  return toFile.map((h) => h.capture);
}

/** The captures waiting for a confirmation, oldest first. */
export function capturesToConfirm(): HeldCapture[] {
  return held.filter((h) => h.ask);
}

/** Stops holding one capture (confirmed or discarded); returns it, or null if it was gone. */
export function releaseCapture(id: number): CaptureResult | null {
  const entry = held.find((h) => h.id === id);
  if (!entry) return null;
  held = held.filter((h) => h !== entry);
  changed();
  return entry.capture;
}

export function hasHeldCaptures(): boolean {
  return held.length > 0;
}

/** Swaps each held capture for what `replace` makes of it — same number, same order. */
export function replaceHeldCaptures(replace: (capture: CaptureResult, index: number) => CaptureResult): void {
  held = held.map((h, i) => ({ ...h, capture: replace(h.capture, i) }));
  changed();
}

export function subscribeHeldCaptures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function heldCapturesVersion(): number {
  return version;
}
