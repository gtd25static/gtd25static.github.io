import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { setSyncProgressCallback, startScheduler, stopScheduler, syncNow } from './sync-engine';
import type { SyncProgress } from './sync-engine';
import type { SyncErrorInfo } from './sync-errors';

export interface SyncData {
  syncEnabled: boolean;
  pendingChanges: boolean;
  lastPushedAt?: number;
  lastPulledAt?: number;
  syncProgress: SyncProgress | null;
  lastSyncStats: { pulled: number; pushed: number } | null;
  /** Last failure, kept until the next successful sync clears it. */
  lastErrorInfo: SyncErrorInfo | null;
  online: boolean;
  triggerSync: () => void;
}

const defaultSync: SyncData = {
  syncEnabled: false,
  pendingChanges: false,
  syncProgress: null,
  lastSyncStats: null,
  lastErrorInfo: null,
  online: true,
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
  const [lastErrorInfo, setLastErrorInfo] = useState<SyncErrorInfo | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);

  // Subscribe to sync progress
  useEffect(() => {
    setSyncProgressCallback((progress) => {
      setSyncProgress(progress);
      if (progress.phase === 'done') {
        setLastSyncStats({ pulled: progress.pulled ?? 0, pushed: progress.pushed ?? 0 });
        setLastErrorInfo(null);
      }
      if (progress.phase === 'error') {
        // Kept until the next successful sync — the user can always see WHY it failed
        setLastErrorInfo(progress.errorInfo ?? { category: 'unknown', message: progress.label });
      }
    });
    return () => {
      setSyncProgressCallback(null);
    };
  }, []);

  // Track connectivity for the indicator (the engine skips syncs while offline)
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
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
    lastErrorInfo,
    online,
    triggerSync,
  };
}
