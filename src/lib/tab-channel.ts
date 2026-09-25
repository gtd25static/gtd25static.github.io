// Cross-tab signalling between this app's own tabs (same origin).
//
// Security shape, deliberately narrow: the channel carries SIGNALS ONLY — never
// a key, a passphrase or any content — and every signal it can carry only ever
// REDUCES access (lock, wipe, reload). There is no "unlock" message and there must
// never be one: propagating an unlock would mean shipping the DEK between contexts,
// and a same-origin script could then talk its way into a vault it never had.
// A dropped or ignored message degrades to the old per-tab behaviour, so nothing
// depends on delivery.
//
// `reload` = lock, then reload the tab: the vault was re-keyed underneath it (a
// secondary-passphrase unlock or a re-key in another tab), or Paranoid Mode was
// turned on or off there, so nothing it still holds in memory may outlive that.

export type TabSignal = { type: 'lock' } | { type: 'wipe' } | { type: 'reload' };

const CHANNEL_NAME = 'gtd25-tabs';

// undefined = not looked up yet, null = unsupported in this environment.
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    channel = null; // some embedders expose the constructor but refuse to build one
  }
  return channel;
}

/**
 * Tell this app's OTHER tabs what just happened here. By spec the sender never
 * receives its own message, which is what keeps lock-propagation from ping-ponging.
 */
export function signalOtherTabs(signal: TabSignal): void {
  try {
    getChannel()?.postMessage(signal);
  } catch { /* channel closed or unavailable — callers must not depend on delivery */ }
}

/** Subscribe to signals from other tabs. Returns an unsubscribe function. */
export function onTabSignal(handler: (signal: TabSignal) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (event: MessageEvent) => {
    // Anything else on this channel is not ours: validate before acting.
    const data = event.data as Partial<TabSignal> | null;
    if (data && (data.type === 'lock' || data.type === 'wipe' || data.type === 'reload')) handler(data as TabSignal);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/** Tests only: drop the cached channel so the next call builds a fresh one. */
export function __resetTabChannelForTests(): void {
  try { channel?.close(); } catch { /* already closed */ }
  channel = undefined;
}
