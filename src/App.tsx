import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LockScreen } from './components/security/LockScreen';
import { db, ensureDefaults } from './db';
import { useKeyboard } from './hooks/use-keyboard';
import { useTheme } from './components/settings/ThemeSettings';
import { useVault } from './hooks/use-vault';
import { touchVaultActivity, lock, isParanoidEnabled, DEFAULT_IDLE_MINUTES } from './db/vault';
import { startSystemIdleLock } from './lib/system-idle';
import { checkRecurringTasks } from './hooks/use-recurring';
import { SpecialListProvider } from './hooks/use-special-list';
import { SyncProvider } from './sync/use-sync';
import { usePomodoroClock } from './hooks/use-pomodoro-clock';
import { useUrlCapture } from './hooks/use-url-capture';
import { useNudges } from './hooks/use-nudges';
import { useAppBadge } from './hooks/use-app-badge';

export default function App() {
  // Theme is localStorage-only (no DB), safe to apply even while the vault is
  // locked so the lock screen respects light/dark.
  useTheme();
  const { locked } = useVault();

  return (
    <ErrorBoundary>
      {locked ? <LockScreen /> : <UnlockedApp />}
    </ErrorBoundary>
  );
}

// Everything that reads the (possibly encrypted) database lives here, so none of
// it runs while the vault is locked — the DEK is guaranteed available once this
// mounts (or Paranoid Mode is off entirely).
function UnlockedApp() {
  useEffect(() => {
    ensureDefaults();
  }, []);

  // Check recurring tasks on startup and every 60s
  useEffect(() => {
    checkRecurringTasks();
    const interval = setInterval(checkRecurringTasks, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Defer the idle re-lock on real user interaction.
  useEffect(() => {
    const onActivity = () => touchVaultActivity();
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, []);

  // Best-effort system-wide auto-lock (Chromium IdleDetector): lock when the OS
  // goes idle or the screen locks. No-op where unavailable/denied — the in-app
  // idle timer still applies. Only runs while unlocked (this component is mounted).
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    void (async () => {
      const local = await db.localSettings.get('local');
      if (!isParanoidEnabled() || !local?.paranoidSystemIdleLock) return;
      const thresholdMs = (local.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
      const s = await startSystemIdleLock(thresholdMs, () => lock());
      if (cancelled) s(); else stop = s;
    })();
    return () => { cancelled = true; stop(); };
  }, []);

  useKeyboard();
  usePomodoroClock();
  useUrlCapture();
  useNudges();
  useAppBadge();

  return (
    <SyncProvider>
      <SpecialListProvider>
        <AppShell />
      </SpecialListProvider>
    </SyncProvider>
  );
}
