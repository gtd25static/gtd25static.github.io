import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { syncNow, hasDirtyFlag, setSyncProgressCallback } from './sync-engine';
import type { SyncProgress } from './sync-engine';
import { hasPendingEntries } from './change-log';

export function useSync() {
  const local = useLiveQuery(() => db.localSettings.get('local'));
  const syncMeta = useLiveQuery(() => db.syncMeta.get('sync-meta'));
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  // Subscribe to sync progress
  useEffect(() => {
    setSyncProgressCallback((progress) => setSyncProgress(progress));
    return () => setSyncProgressCallback(null);
  }, []);

  // Auto-clear done/error progress after 2s
  useEffect(() => {
    if (syncProgress && (syncProgress.phase === 'done' || syncProgress.phase === 'error')) {
      const timer = setTimeout(() => setSyncProgress(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [syncProgress]);

  // Crash recovery: if dirty flag is set on startup, sync immediately
  useEffect(() => {
    if (!local?.syncEnabled) return;
    if (hasDirtyFlag()) {
      syncNow();
    }
  }, [local?.syncEnabled]);

  // Periodic sync (5 min fallback)
  useEffect(() => {
    if (!local?.syncEnabled) return;
    const interval = setInterval(syncNow, local.syncIntervalMs);
    return () => clearInterval(interval);
  }, [local?.syncEnabled, local?.syncIntervalMs]);

  // visibilitychange: pull on visible, push on hidden
  useEffect(() => {
    if (!local?.syncEnabled) return;
    const handler = async () => {
      if (document.visibilityState === 'visible') {
        syncNow();
      } else if (document.visibilityState === 'hidden') {
        const pending = await hasPendingEntries();
        if (pending) syncNow();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [local?.syncEnabled]);

  // Sync on online if pending changes
  useEffect(() => {
    if (!local?.syncEnabled) return;
    const handler = async () => {
      const pending = await hasPendingEntries();
      if (pending) syncNow();
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [local?.syncEnabled]);

  return {
    syncEnabled: local?.syncEnabled ?? false,
    pendingChanges: syncMeta?.pendingChanges ?? false,
    lastPushedAt: syncMeta?.lastPushedAt,
    lastPulledAt: syncMeta?.lastPulledAt,
    syncProgress,
  };
}
