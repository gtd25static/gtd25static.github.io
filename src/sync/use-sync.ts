import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { setSyncProgressCallback, startScheduler, stopScheduler, syncNow } from './sync-engine';
import type { SyncProgress } from './sync-engine';

export function useSync() {
  const local = useLiveQuery(() => db.localSettings.get('local'));
  const syncMeta = useLiveQuery(() => db.syncMeta.get('sync-meta'));
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [lastSyncStats, setLastSyncStats] = useState<{ pulled: number; pushed: number } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Subscribe to sync progress
  useEffect(() => {
    setSyncProgressCallback((progress) => {
      setSyncProgress(progress);
      if (progress.phase === 'done' && progress.pulled != null && progress.pushed != null) {
        setLastSyncStats({ pulled: progress.pulled, pushed: progress.pushed });
        setLastError(null);
      }
      if (progress.phase === 'error') {
        setLastError(progress.label);
        // Clear error display after 4s
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => setLastError(null), 4000);
      }
    });
    return () => {
      setSyncProgressCallback(null);
      clearTimeout(errorTimerRef.current);
    };
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

  const triggerSync = useCallback(() => {
    syncNow(true);
  }, []);

  return {
    syncEnabled: local?.syncEnabled ?? false,
    pendingChanges: syncMeta?.pendingChanges ?? false,
    lastPushedAt: syncMeta?.lastPushedAt,
    lastPulledAt: syncMeta?.lastPulledAt,
    syncProgress,
    lastSyncStats,
    lastError,
    triggerSync,
  };
}
