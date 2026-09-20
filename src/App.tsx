import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LockScreen } from './components/security/LockScreen';
import { ensureDefaults, onDatabaseSupersededByOtherTab } from './db';
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
import { ShareTargetPrompt } from './components/banners/ShareTargetPrompt';
import { PrivacyOverlay } from './components/security/PrivacyOverlay';
import { useBackgroundLock, DEFAULT_BACKGROUND_LOCK_SECONDS } from './hooks/use-background-lock';
import { useAppBadge } from './hooks/use-app-badge';
import { ServiceWorkerProvider } from './hooks/use-service-worker';
import { AppUpdatePrompt } from './components/banners/AppUpdatePrompt';
import { useLocalSettings, updateLocalSettings } from './hooks/use-settings';
import { useRelaxedUnlock } from './hooks/use-relaxed-unlock';
import { useUnlockAudit } from './hooks/use-unlock-audit';
import { UnlockAuditAlert } from './components/security/UnlockAuditAlert';
import { useRelaxedUnlockStore } from './stores/relaxed-unlock';
import { confirmDialog, canConfirm } from './components/ui/ConfirmDialog';

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

  // Another tab upgraded (or deleted) the database, so this tab's connection was
  // closed under it and every query from here on would fail. Nothing recovers
  // without a reload, so say so plainly instead of quietly breaking.
  useEffect(() => onDatabaseSupersededByOtherTab(() => {
    // The dialog host lives in AppShell, so on the lock screen there is nobody to
    // ask — and nothing to lose either. Reload straight away.
    if (!canConfirm()) {
      window.location.reload();
      return;
    }
    void confirmDialog(
      'This app was updated in another tab, so this one can no longer reach its data. Reload to continue.',
      { confirmLabel: 'Reload' },
    ).then((reload) => {
      if (reload) window.location.reload();
    });
  }), []);

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
  // Mirrors localSettings.paranoidSystemIdleUnavailable without making the
  // detector effect depend on a value that same effect writes.
  const systemIdleUnavailableRef = useRef(!!localSettings.paranoidSystemIdleUnavailable);

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
      // The OS system-idle threshold stays at the BASE value (Relaxed unlock does not
      // relax true-absence detection, and it can't be live-adjusted without resetting
      // OS idle detection). Only the screen-lock grace is relaxed, read live at lock time.
      const thresholdMs = (localSettings.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
      const baseGraceMs = localSettings.paranoidSystemLockGraceEnabled
        ? (localSettings.paranoidSystemLockGraceMinutes ?? DEFAULT_SYSTEM_LOCK_GRACE_MINUTES) * 60_000
        : 0;
      const relaxed = !!localSettings.relaxedUnlockEnabled;
      const screenLockGraceMs = () =>
        baseGraceMs === 0 || !relaxed
          ? baseGraceMs
          : useRelaxedUnlockStore.getState().effectiveGraceMs || baseGraceMs;
      let unavailable = false;
      const s = await startSystemIdleLock(thresholdMs, () => lock(), {
        screenLockGraceMs,
        onUnavailable: () => { unavailable = true; },
      });
      if (cancelled) { s(); return; }
      stop = s;
      // Persist the outcome so Settings can tell the truth about this toggle
      // instead of rendering a protection the device is not actually providing.
      // Read through a ref, not the settings snapshot: making this effect depend
      // on what it writes would re-run it — aborting and rebuilding the detector,
      // which resets the OS idle accumulation — every time the value flipped.
      if (systemIdleUnavailableRef.current !== unavailable) {
        systemIdleUnavailableRef.current = unavailable;
        void updateLocalSettings({ paranoidSystemIdleUnavailable: unavailable || undefined })
          .catch((err) => recordError('systemIdle.persistAvailability', err));
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [
    localSettings.paranoidIdleTimeoutMinutes,
    localSettings.paranoidSystemIdleLock,
    localSettings.paranoidSystemLockGraceEnabled,
    localSettings.paranoidSystemLockGraceMinutes,
    localSettings.relaxedUnlockEnabled,
  ]);

  useKeyboard();
  useBackgroundLock(
    !!localSettings.paranoidBackgroundLockEnabled,
    localSettings.paranoidBackgroundLockSeconds ?? DEFAULT_BACKGROUND_LOCK_SECONDS,
  );
  useUrlCapture();
  const shareTarget = useShareTarget();
  useNudges();
  useRelaxedUnlock();
  const unlockAudit = useUnlockAudit();
  useAppBadge();

  return (
    <SyncProvider>
      <SpecialListProvider>
        {/* Approver duties (non-Paranoid devices): accept RUK invites + show an
            attention-grabbing approval overlay for managed devices' unlock requests. */}
        <RemoteApprovalPrompt />
        {/* Failed unlock attempts while you were away — acknowledged, not toasted. */}
        <UnlockAuditAlert {...unlockAudit} />
        {/* Destination prompt for Android share-sheet content (Inbox vs Shared Folder). */}
        <ShareTargetPrompt {...shareTarget} />
        <AppShell />
        {/* Paranoid extra (opt-in): blur veil while unlocked but unattended. */}
        {isParanoidEnabled() && localSettings.paranoidPrivacyOverlayEnabled && (
          <PrivacyOverlay immediate={!!localSettings.paranoidPrivacyOverlayImmediate} />
        )}
      </SpecialListProvider>
    </SyncProvider>
  );
}
