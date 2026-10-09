import { isUnlocking } from '../db/vault';
import { isUnlockRequestLive } from '../sync/remote-unlock';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { lockScreenInUse } from './lock-screen-activity';
import { anyTabUnlocked } from './unlocked-presence';

// What a reload now would break on this device, as far as it can be seen here.
function busyHere(): boolean {
  return isUnlocking()                             // Argon2 or the work after it: the vault still reads "locked"
    || isUnlockRequestLive()                       // a trusted device may be about to approve this one
    || lockScreenInUse()                           // typing, confirming a wipe, or a touch a moment ago
    || usePomodoroStore.getState().ambientPlaying; // it stops, and can't start again without a click
}

/**
 * Whether a locked Paranoid device may apply a waiting update now, unasked
 * (AppUpdatePrompt). The reload hits every tab, so also not while another tab
 * has its vault open, nor when that can't be told. Checked again after the
 * cross-tab query, which waits.
 */
export async function safeToUpdateWhileLocked(): Promise<boolean> {
  if (busyHere()) return false;
  const others = await anyTabUnlocked();
  return others === false && !busyHere();
}
