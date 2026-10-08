import { useEffect, useState, useSyncExternalStore } from 'react';

// On a trusted device, unlock requests come before updates: opening the app (or
// coming back to it) looks for requests first, and the update prompt waits until
// that look found none — and while one is on screen, until it is answered. You
// open the app to answer a request; an update dialog must not be what you find.
//
// 'checking': the look for requests is in flight. 'request': the prompt is on
// screen. 'idle': nothing to wait for (a held-back request's line sits above the
// update prompt, so the update need not wait for it).
export type ApprovalState = 'idle' | 'checking' | 'request';

// The look for requests is given this long. Past it the update shows anyway: a
// slow network should not hide it, and neither should an app that crashed below
// the prompt (the update is the way out of a broken build).
export const APPROVAL_CHECK_GRACE_MS = 20_000;

// 'idle' until the approver hook (hooks/use-remote-unlock) mounts and says
// 'checking': it does in the app's first render, before an update can show (that
// waits on a network check), and a device that never mounts it — a Paranoid one
// on its lock screen, an app that crashed below the prompt — waits for nothing.
let state: ApprovalState = 'idle';
let checkingSince = Date.now();
const listeners = new Set<() => void>();

export function setApprovalState(next: ApprovalState): void {
  if (next === state) return;
  if (next === 'checking') checkingSince = Date.now();
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): ApprovalState => state;

/** Whether the update prompt should wait for the unlock requests now. */
export function useUpdatesHeldForApprovals(): boolean {
  const current = useSyncExternalStore(subscribe, snapshot);
  const since = checkingSince;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (current !== 'checking') return;
    const left = since + APPROVAL_CHECK_GRACE_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [current, since]);
  return current === 'request' || (current === 'checking' && Date.now() - since < APPROVAL_CHECK_GRACE_MS);
}

export function __resetApprovalGateForTests(next: ApprovalState = 'idle'): void {
  state = next;
  checkingSince = Date.now();
  listeners.forEach((l) => l());
}
