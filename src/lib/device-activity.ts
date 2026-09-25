import { formatDate, formatTimeAgo } from './date-utils';

/** A trusted device calls a protected one inactive after this long without a registry refresh. */
export const DEVICE_INACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What a trusted device shows about a protected device's activity: when it last
 * refreshed its registry entry (it does, at most daily, while unlocked). Silence
 * is all there is to go on — a device wiped by its secondary passphrase sends
 * nothing — so a long one reads as "no activity since …", never as "wiped".
 * Null until a refresh has been seen.
 */
export function deviceActivity(lastSeenAt: number | undefined, now: number = Date.now()): { text: string; inactive: boolean } | null {
  if (!lastSeenAt) return null;
  if (now - lastSeenAt < DEVICE_INACTIVE_MS) return { text: `Last seen ${formatTimeAgo(lastSeenAt)}`, inactive: false };
  return {
    text: `No activity since ${formatDate(lastSeenAt)} — unused, lost or wiped? You can send a wipe, then forget it.`,
    inactive: true,
  };
}
