import { useState, useEffect, useCallback, useRef, createContext, useContext, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { setSyncProgressCallback, startScheduler, stopScheduler, syncNow } from './sync-engine';
import type { SyncProgress } from './sync-engine';

export interface SyncData {
  syncEnabled: boolean;
  pendingChanges: boolean;
  lastPushedAt?: number;
  lastPulledAt?: number;
  syncProgress: SyncProgress | null;
  lastSyncStats: { pulled: number; pushed: number } | null;
  lastError: string | null;
  triggerSync: () => void;
}

const defaultSync: SyncData = {
  syncEnabled: false,
  pendingChanges: false,
  syncProgress: null,
  lastSyncStats: null,
  lastError: null,
  triggerSync: () => {},
};

const SyncContext = createContext<SyncData>(defaultSync);

export function SyncProvider({ children }: { children: ReactNode }) {
  const data = useSync();
  return <SyncContext.Provider value={data}>{children}</SyncContext.Provider>;
}

export function useSyncContext(): SyncData {
  return useContext(SyncContext);
}

function useSync() {
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
      if (progress.phase === 'done') {
        const pulled = progress.pulled ?? 0;
        const pushed = progress.pushed ?? 0;
        if (pulled > 0 || pushed > 0) {
          setLastSyncStats({ pulled, pushed });
        }
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
