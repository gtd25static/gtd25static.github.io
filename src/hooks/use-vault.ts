import { useSyncExternalStore } from 'react';
import { subscribeVault, getVaultSnapshot } from '../db/vault';

/**
 * Reactive Paranoid Mode state.
 * - `enabled`: device has Paranoid Mode on (read synchronously from localStorage).
 * - `unlocked`: the DEK is in memory.
 * - `locked`: enabled but not yet unlocked -> show the lock screen / gate the app.
 * - `hasSecurityKey`: a FIDO2 security-key credential is enrolled on this device.
 */
export function useVault(): { enabled: boolean; unlocked: boolean; locked: boolean; hasSecurityKey: boolean } {
  const snap = useSyncExternalStore(subscribeVault, getVaultSnapshot, getVaultSnapshot);
  return {
    enabled: snap.enabled,
    unlocked: snap.unlocked,
    locked: snap.enabled && !snap.unlocked,
    hasSecurityKey: snap.hasSecurityKey,
  };
}
