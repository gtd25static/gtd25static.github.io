import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { setSyncProgressCallback, startScheduler, stopScheduler } from './sync-engine';
import type { SyncProgress } from './sync-engine';

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

  // Start/stop scheduler based on sync enabled
  useEffect(() => {
    if (!local?.syncEnabled) return;
    startScheduler();
    return () => stopScheduler();
  }, [local?.syncEnabled]);

  return {
    syncEnabled: local?.syncEnabled ?? false,
    pendingChanges: syncMeta?.pendingChanges ?? false,
    lastPushedAt: syncMeta?.lastPushedAt,
    lastPulledAt: syncMeta?.lastPulledAt,
    syncProgress,
  };
}
