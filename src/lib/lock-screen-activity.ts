// Whether someone is using the lock screen right now, for the update a locked
// Paranoid device applies on its own (lib/locked-update): it reloads the page,
// and must not do it under a passphrase being typed, a wipe being confirmed, or a
// hand that touched the screen a moment ago. Memory only; LockScreen reports it.

const RECENT_INPUT_MS = 10_000;

let typed = false;
let confirmingWipe = false;
let lastInputAt = 0;

/** What the lock screen shows: text in the passphrase field, the wipe confirmation. */
export function setLockScreenState(state: { typed: boolean; confirmingWipe: boolean }): void {
  typed = state.typed;
  confirmingWipe = state.confirmingWipe;
}

/** A key press or a touch on the lock screen. */
export function noteLockScreenInput(now = Date.now()): void {
  lastInputAt = now;
}

export function lockScreenInUse(now = Date.now()): boolean {
  return typed || confirmingWipe || now - lastInputAt < RECENT_INPUT_MS;
}

export function __resetLockScreenActivityForTests(): void {
  typed = false;
  confirmingWipe = false;
  lastInputAt = 0;
}
