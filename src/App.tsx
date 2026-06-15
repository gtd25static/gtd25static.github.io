import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LockScreen } from './components/security/LockScreen';
import { ensureDefaults } from './db';
import { useKeyboard } from './hooks/use-keyboard';
import { useTheme } from './components/settings/ThemeSettings';
import { useVault } from './hooks/use-vault';
import { touchVaultActivity, lock, isParanoidEnabled, DEFAULT_IDLE_MINUTES } from './db/vault';
import { startSystemIdleLock, DEFAULT_SYSTEM_LOCK_GRACE_MINUTES } from './lib/system-idle';
import { checkRecurringTasks } from './hooks/use-recurring';
import { recordError } from './lib/diagnostics';
import { SpecialListProvider } from './hooks/use-special-list';
import { SyncProvider } from './sync/use-sync';
import { usePomodoroClock } from './hooks/use-pomodoro-clock';
import { useUrlCapture } from './hooks/use-url-capture';
import { useShareTarget } from './hooks/use-share-target';
import { useNudges, useLockedNudge } from './hooks/use-nudges';
import { useRemoteWipeCommands } from './hooks/use-remote-unlock';
import { RemoteApprovalPrompt } from './components/security/RemoteApprovalPrompt';
import { useAppBadge } from './hooks/use-app-badge';
import { ServiceWorkerProvider } from './hooks/use-service-worker';
import { AppUpdatePrompt } from './components/banners/AppUpdatePrompt';
import { useLocalSettings } from './hooks/use-settings';

export default function App() {
  // Theme is localStorage-only (no DB), safe to apply even while the vault is
  // locked so the lock screen respects light/dark.
  useTheme();
  const { locked } = useVault();

  // Background tasks that DON'T touch decrypted data run here (always mounted),
  // so they keep working while the vault is locked:
  //  - the Pomodoro clock (timer + bell + "Pomodoro Complete" — no task content),
  //  - a generic, content-free nudge to unlock (no task titles; see useLockedNudge).
  usePomodoroClock();
  useLockedNudge();
  useRemoteWipeCommands();

  return (
    <ErrorBoundary>
      {/* SW update detection + the update prompt run from here (always mounted),
          so updates can be applied even from the lock screen — no wipe needed if
          a bug blocks unlock. */}
      <ServiceWorkerProvider>
        <AppUpdatePrompt />
        {locked ? <LockScreen /> : <UnlockedApp />}
      </ServiceWorkerProvider>
    </ErrorBoundary>
  );
}

// Everything that reads the (possibly encrypted) database lives here, so none of
// it runs while the vault is locked — the DEK is guaranteed available once this
// mounts (or Paranoid Mode is off entirely).
function UnlockedApp() {
  const localSettings = useLocalSettings();

  useEffect(() => {
    ensureDefaults();
  }, []);

  // Check recurring tasks on startup and every 60s. A persistent DB failure here
  // is otherwise invisible (recurring tasks silently stop resetting) — tag it in
  // the diagnostics log with context.
  useEffect(() => {
    const check = () => void checkRecurringTasks().catch((e) => recordError('recurring.check', e));
    check();
    const interval = setInterval(check, 60_000);
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
      if (!isParanoidEnabled() || !localSettings.paranoidSystemIdleLock) return;
      const thresholdMs = (localSettings.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
      const screenLockGraceMs = localSettings.paranoidSystemLockGraceEnabled
        ? (localSettings.paranoidSystemLockGraceMinutes ?? DEFAULT_SYSTEM_LOCK_GRACE_MINUTES) * 60_000
        : 0;
      const s = await startSystemIdleLock(thresholdMs, () => lock(), { screenLockGraceMs });
      if (cancelled) s(); else stop = s;
    })();
    return () => { cancelled = true; stop(); };
  }, [
    localSettings.paranoidIdleTimeoutMinutes,
    localSettings.paranoidSystemIdleLock,
    localSettings.paranoidSystemLockGraceEnabled,
    localSettings.paranoidSystemLockGraceMinutes,
  ]);

  useKeyboard();
  useUrlCapture();
  useShareTarget();
  useNudges();
  useAppBadge();

  return (
    <SyncProvider>
      <SpecialListProvider>
        {/* Approver duties (non-Paranoid devices): accept RUK invites + show an
            attention-grabbing approval overlay for managed devices' unlock requests. */}
        <RemoteApprovalPrompt />
        <AppShell />
      </SpecialListProvider>
    </SyncProvider>
  );
}
