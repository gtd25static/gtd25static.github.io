import { useState, useEffect, useCallback } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useVault } from '../../hooks/use-vault';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import {
  isSystemIdleSupported, requestSystemIdlePermission,
  DEFAULT_SYSTEM_LOCK_GRACE_MINUTES, clampSystemLockGraceMinutes,
} from '../../lib/system-idle';
import { useRelaxedUnlockStore } from '../../stores/relaxed-unlock';
import { clampBackgroundLockSeconds, DEFAULT_BACKGROUND_LOCK_SECONDS } from '../../hooks/use-background-lock';
import { unlocksInWindow, effectiveMinutes } from '../../lib/relaxed-unlock';
import {
  enableParanoid, disableParanoid, changePassphrase, configureIdleTimeout,
  configureMaxUnlockAttempts, verifyAtRestIntegrity, lock, addSecurityKey, removeSecurityKey,
  listSecurityKeys, DEFAULT_IDLE_MINUTES, DEFAULT_MAX_ATTEMPTS,
} from '../../db/vault';
import { isWebAuthnSupported } from '../../sync/webauthn-prf';
import {
  isRemoteUnlockEnrolled, listEnrolledApprovers, listApproverCandidates, buildEnrollContext,
  enableRemoteUnlock, addApprovers, disableRemoteUnlock, setDeviceName, getDeviceName,
  publishOwnRegistryEntry, listApprovedDevices, sendRemoteWipe, pollApproverInbox,
  refreshManagedDeviceWipeStatuses, purgeManagedDevice, forgetManagedDeviceAfterWipeCommand,
  type RegistryEntry, type ManagedDevice,
} from '../../sync/remote-unlock';
import { identityFingerprint } from '../../sync/remote-unlock-crypto';
import { panicWipe } from '../../lib/panic-wipe';
import { exportToZip } from '../../db/export-import';
import { recordError } from '../../lib/diagnostics';
import { clearUnlockLog } from '../../lib/unlock-audit';
import { clampClipboardClearSeconds, DEFAULT_CLIPBOARD_CLEAR_SECONDS } from '../../lib/clipboard-hygiene';
import { checkSecretStrength } from '../../lib/password-strength';
import { PasswordStrengthBar } from '../ui/PasswordStrengthBar';

function clampMinutes(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_IDLE_MINUTES;
  return Math.max(1, Math.min(240, n));
}

function EnableForm() {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [idle, setIdle] = useState(String(DEFAULT_IDLE_MINUTES));
  const [busy, setBusy] = useState(false);

  async function handleEnable() {
    if (pass !== confirm) { toast('Passphrases do not match', 'error'); return; }
    if (!pass.trim()) { toast('Choose a passphrase', 'error'); return; }
    const strength = checkSecretStrength(pass.trim(), 'vault');
    if (!strength.ok) { toast(strength.reason!, 'error'); return; }
    setBusy(true);
    try {
      await enableParanoid(pass.trim(), clampMinutes(idle));
      toast('Paranoid Mode enabled — local data is now encrypted', 'success');
      setPass(''); setConfirm('');
    } catch (e) {
      recordError('security.enableParanoid', e);
      toast(e instanceof Error ? e.message : 'Could not enable Paranoid Mode', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Paranoid Mode</h3>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Encrypts all task data on this device at rest. The app locks and requires this passphrase
        to decrypt. Use on devices you do not fully trust. There is no recovery if you forget the
        passphrase — local data becomes unreadable (data synced to other devices is unaffected).
      </p>
      <Input label="Passphrase" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Choose a strong passphrase" disabled={busy} />
      <PasswordStrengthBar secret={pass.trim()} kind="vault" />
      <Input label="Confirm passphrase" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat passphrase" disabled={busy} />
      <Input label="Auto-lock after (minutes idle)" type="number" min={1} max={240} value={idle} onChange={(e) => setIdle(e.target.value)} disabled={busy} />
      <Button size="sm" variant="danger" onClick={handleEnable} disabled={busy}>
        {busy ? 'Encrypting…' : 'Enable Paranoid Mode'}
      </Button>
    </div>
  );
}

function SecurityKeySection({ hasSecurityKey }: { hasSecurityKey: boolean }) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [keys, setKeys] = useState<Array<{ credentialId: string; label?: string; addedAt: number }>>([]);
  const available = isWebAuthnSupported();

  const reload = useCallback(async () => { setKeys(await listSecurityKeys()); }, []);
  // Reload on mount and whenever the "any key enrolled" flag flips (enable/disable,
  // first/last key). Adding a 2nd key keeps the flag true, so handlers also reload.
  useEffect(() => { void reload(); }, [reload, hasSecurityKey]);

  async function handleAdd() {
    setBusy(true);
    try {
      await addSecurityKey(label);
      setLabel('');
      await reload();
      toast('Security key added', 'success');
    } catch (e) {
      // registerPrfCredential throws a specific reason (cancelled / unsupported /
      // empty PRF). NotAllowedError = the user dismissed the prompt.
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) {
        recordError('security.addSecurityKey', e);
      }
      const msg = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Security key setup was cancelled'
        : e instanceof Error ? e.message : 'Could not add the security key';
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(credentialId: string, name: string) {
    const last = keys.length <= 1;
    const ok = await confirmDialog(
      `Remove "${name}"?${last ? ' You will need your passphrase to unlock this device.' : ''}`,
      { confirmLabel: 'Remove', danger: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await removeSecurityKey(credentialId);
      await reload();
      toast('Security key removed', 'success');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Security keys</h4>
      {!available ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Security keys are not supported in this browser.
        </p>
      ) : (
        <>
          {keys.length > 0 ? (
            <ul className="space-y-1">
              {keys.map((k) => (
                <li key={k.credentialId} className="flex items-center justify-between gap-2 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/40">
                  <span className="min-w-0 truncate text-xs text-emerald-600 dark:text-emerald-400">
                    {k.label || 'Security key'}
                    {k.addedAt > 0 && (
                      <span className="text-zinc-400 dark:text-zinc-500"> · added {new Date(k.addedAt).toLocaleDateString()}</span>
                    )}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => handleRemove(k.credentialId, k.label || 'Security key')} disabled={busy}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Add a FIDO2 security key (YubiKey) or your phone as a keylogger-safe unlock — no typing,
              so a keylogger sees nothing. Enroll more than one (e.g. a backup key) so you are never
              locked out if one is unavailable. Your passphrase still works as a fallback.
            </p>
          )}
          <div className="flex items-end gap-2">
            <Input
              label="Name (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. YubiKey, Phone"
              disabled={busy}
            />
            <Button size="sm" variant="secondary" onClick={handleAdd} disabled={busy}>
              {busy ? 'Waiting…' : 'Add security key or phone'}
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
            To enroll a phone, choose <span className="font-medium">“Use a phone or tablet”</span> in the
            prompt and scan the QR with it (the phone must support PRF — recent Android does).
          </p>
        </>
      )}
    </div>
  );
}

function SystemIdleToggle({ enabled, graceEnabled, graceMinutes }: { enabled: boolean; graceEnabled: boolean; graceMinutes: number }) {
  const supported = isSystemIdleSupported();
  const [busy, setBusy] = useState(false);
  const [grace, setGrace] = useState(String(graceMinutes));

  useEffect(() => {
    setGrace(String(graceMinutes));
  }, [graceMinutes]);

  async function saveGrace() {
    const n = clampSystemLockGraceMinutes(grace);
    await updateLocalSettings({ paranoidSystemLockGraceMinutes: n });
    setGrace(String(n));
    toast(`Will wait ${n} ${n === 1 ? 'minute' : 'minutes'} after screen lock before locking GTD25`, 'success');
  }

  async function toggle() {
    setBusy(true);
    try {
      if (enabled) {
        await updateLocalSettings({ paranoidSystemIdleLock: false });
        toast('System idle lock disabled', 'success');
      } else {
        const granted = await requestSystemIdlePermission();
        if (!granted) { toast('Idle-detection permission denied or unavailable', 'error'); return; }
        await updateLocalSettings({ paranoidSystemIdleLock: true });
        toast('Will lock on system idle / screen lock', 'success');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">System idle lock</h4>
      {supported ? (
        <>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Lock when the whole system goes idle or the screen locks — not just this app. Needs a
            one-time browser permission (Chrome/Edge). Reapplies the auto-lock minutes above.
          </p>
          <Button size="sm" variant="secondary" onClick={toggle} disabled={busy}>
            {enabled ? 'Disable system idle lock' : 'Enable system idle lock'}
          </Button>
          {enabled && (
            <div className="space-y-2 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/40">
              <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={graceEnabled}
                  onChange={async (e) => {
                    const on = e.currentTarget.checked;
                    await updateLocalSettings({ paranoidSystemLockGraceEnabled: on });
                    toast(
                      on
                        ? 'Will delay GTD25 lock after screen lock'
                        : 'Will lock GTD25 immediately on screen lock',
                      'success',
                    );
                  }}
                  className="mt-0.5 rounded accent-accent-600"
                />
                <span>
                  Delay GTD25 lock after a brief screen lock
                  <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                    Avoids a full app unlock for short screen locks. System idle still locks normally.
                  </span>
                </span>
              </label>
              {graceEnabled && (
                <div className="flex items-end gap-2 pl-6">
                  <Input
                    label="Delay after screen lock (minutes)"
                    type="number"
                    min={1}
                    max={60}
                    value={grace}
                    onChange={(e) => setGrace(e.target.value)}
                  />
                  <Button size="sm" variant="secondary" onClick={saveGrace}>Save</Button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Not available in this browser (Chrome/Edge only). The in-app idle timer still applies.
        </p>
      )}
    </div>
  );
}

// Paranoid extras: the opt-in add-ons for Paranoid Mode. Every toggle is
// device-local and defaults off. Each renders its own row so the section
// grows one <ExtraToggle> per feature.
function ParanoidExtrasSection() {
  const local = useLocalSettings();
  return (
    <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Paranoid extras</h4>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Optional hardening for this device. All off by default.
        </p>
      </div>
      <ExtraToggle
        label="Privacy screen"
        description="Blur the whole app when it goes to the background or sits untouched for half the auto-lock time. Any movement or key brings it back. Hides the screen from onlookers — the real protection is still the auto-lock."
        checked={!!local.paranoidPrivacyOverlayEnabled}
        onChange={(on) => updateLocalSettings({ paranoidPrivacyOverlayEnabled: on })}
      />
      <ExtraToggle
        label="Lock when hidden"
        description="Lock the vault once this tab has been in the background for the delay below (0 = immediately). Catches tab switches, which the system idle lock doesn't see. Background timers are throttled, so read it as “at least” that many seconds."
        checked={!!local.paranoidBackgroundLockEnabled}
        onChange={(on) => updateLocalSettings({ paranoidBackgroundLockEnabled: on })}
      >
        <BackgroundLockDelay seconds={local.paranoidBackgroundLockSeconds ?? DEFAULT_BACKGROUND_LOCK_SECONDS} />
      </ExtraToggle>
      <ExtraToggle
        label="Redact mode (Ctrl/Cmd+Shift+H)"
        description="Adds an eye button (sidebar, bottom) and a hotkey that blur titles and content across the app, revealing only what's under the cursor or keyboard focus. For working in public. Deterrence only — a photo of the screen still blurs, but the data is on the device."
        checked={!!local.paranoidRedactModeEnabled}
        onChange={(on) => updateLocalSettings({ paranoidRedactModeEnabled: on })}
      />
      <ExtraToggle
        label="Instant-lock hotkey (Ctrl/Cmd+Shift+L)"
        description="Lock the vault from anywhere with one chord — the reflex version of the sidebar lock button. Works even while typing in a field."
        checked={!!local.paranoidLockHotkeyEnabled}
        onChange={(on) => updateLocalSettings({ paranoidLockHotkeyEnabled: on })}
      />
      <ExtraToggle
        label="Unlock audit trail"
        description="Keep a private log of unlocks and failed attempts on this device (never synced). After unlocking you'll see when it was last unlocked and how many wrong attempts happened since — so tampering while you were away is visible."
        checked={!!local.paranoidUnlockLogEnabled}
        onChange={(on) => updateLocalSettings({ paranoidUnlockLogEnabled: on })}
      >
        <UnlockLogView log={local.unlockLog ?? []} />
      </ExtraToggle>
      <ExtraToggle
        label="Auto-clear clipboard"
        description="After you copy from the app (an outline, a PNG, a diagnostics report), wipe the clipboard once the delay below passes. Best-effort: it can't reach OS clipboard history, and needs the app focused to clear."
        checked={!!local.paranoidClipboardClearEnabled}
        onChange={(on) => updateLocalSettings({ paranoidClipboardClearEnabled: on })}
      >
        <ClipboardClearDelay seconds={local.paranoidClipboardClearSeconds ?? DEFAULT_CLIPBOARD_CLEAR_SECONDS} />
      </ExtraToggle>
    </div>
  );
}

function ClipboardClearDelay({ seconds }: { seconds: number }) {
  const [value, setValue] = useState(String(seconds));
  useEffect(() => { setValue(String(seconds)); }, [seconds]);
  return (
    <div className="flex items-end gap-2 pl-6">
      <Input
        label="Clear after (seconds)"
        type="number"
        min={10}
        max={300}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          const n = clampClipboardClearSeconds(value);
          await updateLocalSettings({ paranoidClipboardClearSeconds: n });
          setValue(String(n));
          toast(`Clipboard will clear ${n}s after copying`, 'success');
        }}
      >
        Save
      </Button>
    </div>
  );
}

function UnlockLogView({ log }: { log: import('../../lib/unlock-audit').UnlockLogEntry[] }) {
  const recent = [...log].reverse().slice(0, 8);
  const methodLabel = { passphrase: 'passphrase', securityKey: 'security key', remote: 'remote' } as const;
  return (
    <div className="space-y-2 pl-6">
      {recent.length === 0 ? (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">No unlocks recorded yet.</p>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[11px]">
          {recent.map((e, i) => (
            <li key={i} className={e.ok ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-500'}>
              {new Date(e.at).toLocaleString()} · {e.ok ? methodLabel[e.method] : 'failed attempt'}
            </li>
          ))}
        </ul>
      )}
      {log.length > 0 && (
        <Button size="sm" variant="secondary" onClick={async () => { await clearUnlockLog(); toast('Unlock log cleared', 'success'); }}>
          Clear log
        </Button>
      )}
    </div>
  );
}

function BackgroundLockDelay({ seconds }: { seconds: number }) {
  const [value, setValue] = useState(String(seconds));
  useEffect(() => { setValue(String(seconds)); }, [seconds]);
  return (
    <div className="flex items-end gap-2 pl-6">
      <Input
        label="Delay (seconds, 0 = instant)"
        type="number"
        min={0}
        max={300}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          const n = clampBackgroundLockSeconds(value);
          await updateLocalSettings({ paranoidBackgroundLockSeconds: n });
          setValue(String(n));
          toast(n === 0 ? 'Will lock the instant the tab hides' : `Will lock after ${n}s in the background`, 'success');
        }}
      >
        Save
      </Button>
    </div>
  );
}

function ExtraToggle({ label, description, checked, onChange, children }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void | Promise<void>;
  children?: React.ReactNode; // extra controls shown while enabled
}) {
  return (
    <div className="space-y-2 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/40">
      <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => void onChange(e.currentTarget.checked)}
          className="mt-0.5 rounded accent-accent-600"
        />
        <span>
          {label}
          <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">{description}</span>
        </span>
      </label>
      {checked && children}
    </div>
  );
}

function RelaxedUnlockToggle() {
  const local = useLocalSettings();
  const enabled = !!local.relaxedUnlockEnabled;
  const multiplier = useRelaxedUnlockStore((s) => s.multiplier);
  const baseIdle = local.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES;
  const baseGrace = local.paranoidSystemLockGraceMinutes ?? DEFAULT_SYSTEM_LOCK_GRACE_MINUTES;
  const graceOn = !!local.paranoidSystemLockGraceEnabled;
  const unlockCount = unlocksInWindow(local.unlockHistory ?? [], Date.now());

  async function toggle() {
    await updateLocalSettings({ relaxedUnlockEnabled: !enabled });
    toast(enabled ? 'Relaxed unlock disabled' : 'Relaxed unlock enabled', 'success');
  }

  return (
    <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Relaxed unlock</h4>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        On busy days, stretch “auto-lock after” and “delay after screen lock” by +10% for each
        re-unlock in the last 36h (the first unlock doesn’t count), up to 2×. Never more than double
        the values above; system idle still locks at the base time.
      </p>
      <Button size="sm" variant="secondary" onClick={toggle}>
        {enabled ? 'Disable relaxed unlock' : 'Enable relaxed unlock'}
      </Button>
      {enabled && (
        <p className="rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800/40 dark:text-zinc-300">
          Currently <span className="font-medium">+{Math.round((multiplier - 1) * 100)}%</span> — auto-lock
          ~{effectiveMinutes(baseIdle, multiplier, 240)} min
          {graceOn && <> · screen-lock grace ~{effectiveMinutes(baseGrace, multiplier, 60)} min</>}
          {' '}({unlockCount} unlock{unlockCount === 1 ? '' : 's'} in the last 36h).
        </p>
      )}
    </div>
  );
}

function ManageForm({ idleMinutes, maxAttempts, systemIdleOn, systemLockGraceOn, systemLockGraceMinutes, hasSecurityKey }: { idleMinutes: number; maxAttempts: number; systemIdleOn: boolean; systemLockGraceOn: boolean; systemLockGraceMinutes: number; hasSecurityKey: boolean }) {
  const [idle, setIdle] = useState(String(idleMinutes));
  const [attempts, setAttempts] = useState(String(maxAttempts));
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIdle(String(idleMinutes));
  }, [idleMinutes]);

  useEffect(() => {
    setAttempts(String(maxAttempts));
  }, [maxAttempts]);

  async function handleSaveIdle() {
    await configureIdleTimeout(clampMinutes(idle));
    setIdle(String(clampMinutes(idle)));
    toast('Auto-lock updated', 'success');
  }

  async function handleSaveAttempts() {
    const n = Math.max(0, Math.min(50, parseInt(attempts, 10) || 0));
    await configureMaxUnlockAttempts(n);
    setAttempts(String(n));
    toast(n === 0 ? 'Failed-attempt wipe disabled' : `Will wipe after ${n} failed attempts`, 'success');
  }

  async function handleChangePass() {
    if (newPass !== newPassConfirm) { toast('Passphrases do not match', 'error'); return; }
    if (!newPass.trim()) { toast('Enter a new passphrase', 'error'); return; }
    const strength = checkSecretStrength(newPass.trim(), 'vault');
    if (!strength.ok) { toast(strength.reason!, 'error'); return; }
    setBusy(true);
    try {
      await changePassphrase(newPass.trim());
      toast('Passphrase changed', 'success');
      setNewPass(''); setNewPassConfirm('');
    } catch (e) {
      recordError('security.changePassphrase', e);
      toast(e instanceof Error ? e.message : 'Could not change passphrase', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    const ok = await confirmDialog(
      'This decrypts all local data back to plaintext on this device. The data will no longer be protected at rest.',
      { confirmLabel: 'Disable', danger: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await disableParanoid();
      toast('Paranoid Mode disabled — local data decrypted', 'success');
    } catch (e) {
      recordError('security.disableParanoid', e);
      toast(e instanceof Error ? e.message : 'Could not disable Paranoid Mode', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    try {
      const { total, unreadable } = await verifyAtRestIntegrity();
      if (unreadable === 0) toast(`Integrity OK — all ${total} items readable`, 'success');
      else {
        recordError('security.verifyAtRestIntegrity', new Error(`${unreadable} of ${total} items unreadable`));
        toast(`${unreadable} of ${total} items unreadable — re-sync from another device to recover`, 'error');
      }
    } catch (e) {
      recordError('security.verifyAtRestIntegrity', e);
      toast(e instanceof Error ? e.message : 'Verification failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecoveryExport() {
    setBusy(true);
    try {
      const blob = await exportToZip();
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gtd25-recovery-${date}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Recovery backup downloaded', 'success');
    } catch (e) {
      recordError('security.recoveryExport', e);
      toast(e instanceof Error ? e.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handlePanicWipe() {
    const ok = await confirmDialog(
      'Erase ALL local app data on this device — tasks, settings, vault, caches. Data synced to other devices is not affected. This cannot be undone.',
      { confirmLabel: 'Wipe this device', danger: true },
    );
    if (!ok) return;
    await panicWipe(); // reloads on completion
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Paranoid Mode</h3>
        <p className="text-xs text-emerald-600 dark:text-emerald-400">Active — local data on this device is encrypted at rest.</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Backups are disabled on this device (no local snapshots, no remote backup uploads). If
          every synced device is in Paranoid Mode, remote backups stop refreshing.
        </p>
      </div>

      <div className="flex items-end gap-2">
        <Input label="Auto-lock after (minutes idle)" type="number" min={1} max={240} value={idle} onChange={(e) => setIdle(e.target.value)} />
        <Button size="sm" variant="secondary" onClick={handleSaveIdle}>Save</Button>
      </div>

      <div className="space-y-1">
        <div className="flex items-end gap-2">
          <Input label="Wipe after N failed unlock attempts (0 = off)" type="number" min={0} max={50} value={attempts} onChange={(e) => setAttempts(e.target.value)} />
          <Button size="sm" variant="secondary" onClick={handleSaveAttempts}>Save</Button>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Erases local data after too many wrong passphrases at the lock screen. Protects against
          someone guessing at the keyboard; it cannot stop an offline attack on a copied disk.
        </p>
      </div>

      <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <Input label="New passphrase" type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Change passphrase" disabled={busy} />
        <PasswordStrengthBar secret={newPass.trim()} kind="vault" />
        <Input label="Confirm new passphrase" type="password" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder="Repeat new passphrase" disabled={busy} />
        <Button size="sm" variant="secondary" onClick={handleChangePass} disabled={busy}>Change passphrase</Button>
      </div>

      <SystemIdleToggle enabled={systemIdleOn} graceEnabled={systemLockGraceOn} graceMinutes={systemLockGraceMinutes} />

      <RelaxedUnlockToggle />

      <ParanoidExtrasSection />

      <SecurityKeySection hasSecurityKey={hasSecurityKey} />

      <DeviceNameSection />

      <RemoteUnlockSection />

      <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <h4 className="text-sm font-medium">Data safety</h4>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Paranoid devices make no automatic backups. Download a recovery backup before disabling or
          wiping. Verify checks every item still decrypts.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={handleRecoveryExport} disabled={busy}>Download recovery backup</Button>
          <Button size="sm" variant="secondary" onClick={handleVerify} disabled={busy}>Verify integrity</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <Button size="sm" variant="secondary" onClick={() => lock()}>Lock now</Button>
        <Button size="sm" variant="danger" onClick={handleDisable} disabled={busy}>
          {busy ? 'Working…' : 'Disable Paranoid Mode'}
        </Button>
        <Button size="sm" variant="danger" onClick={handlePanicWipe} disabled={busy}>Panic wipe</Button>
      </div>
    </div>
  );
}

// Protected-device side (Paranoid ON, unlocked): enroll trusted devices that can
// remotely unlock or wipe THIS device.
function RemoteUnlockSection() {
  const [enrolled, setEnrolled] = useState(false);
  const [approvers, setApprovers] = useState<Array<{ deviceId: string; name: string }>>([]);
  const [candidates, setCandidates] = useState<Array<{ e: RegistryEntry; fp: string }> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setEnrolled(await isRemoteUnlockEnrolled());
    setApprovers(await listEnrolledApprovers());
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function loadCandidates() {
    setBusy(true);
    try {
      const list = await listApproverCandidates(); // excludes already-enrolled approvers
      const withFp = await Promise.all(list.map(async (e) => ({ e, fp: await identityFingerprint({ ecdhPub: e.ecdhPub, ecdsaPub: e.ecdsaPub }) })));
      setCandidates(withFp); // empty array -> the section shows guidance + Refresh
    } catch (e) {
      recordError('remoteUnlock.loadCandidates', e);
      toast(e instanceof Error ? e.message : 'Could not load devices', 'error');
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (selected.size === 0) { toast('Select at least one device', 'error'); return; }
    setBusy(true);
    try {
      const ctx = await buildEnrollContext();
      if (enrolled) {
        await addApprovers(ctx, [...selected]);
        toast('Trusted device(s) added', 'success');
      } else {
        await enableRemoteUnlock(ctx, [...selected]);
        toast('Remote unlock enabled', 'success');
      }
      setCandidates(null); setSelected(new Set());
      await reload();
    } catch (e) {
      recordError('remoteUnlock.saveEnrollment', e);
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
    } finally { setBusy(false); }
  }

  async function disable() {
    const ok = await confirmDialog('Turn off remote unlock? Trusted devices will no longer be able to unlock or wipe this device.', { confirmLabel: 'Turn off', danger: true });
    if (!ok) return;
    setBusy(true);
    try { await disableRemoteUnlock(); toast('Remote unlock disabled', 'success'); setCandidates(null); await reload(); }
    finally { setBusy(false); }
  }

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  // The candidate picker is shared by first-time setup and "add more devices".
  const picker = candidates && (
    candidates.length === 0 ? (
      <div className="space-y-2">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          No eligible devices found yet. On the device you want to approve from (e.g. your phone, with
          Paranoid Mode OFF), open this app, make sure GitHub sync is set up and has run once, then refresh.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={loadCandidates} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>
          <Button size="sm" variant="secondary" onClick={() => setCandidates(null)} disabled={busy}>Cancel</Button>
        </div>
      </div>
    ) : (
      <div className="space-y-2">
        <ul className="space-y-1">
          {candidates.map(({ e, fp }) => (
            <li key={e.deviceId} className="rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-800/40">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={selected.has(e.deviceId)} onChange={() => toggle(e.deviceId)} disabled={busy} />
                <span className="font-medium text-zinc-700 dark:text-zinc-200">{e.name}</span>
              </label>
              <p className="mt-1 font-mono text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
                Confirm this matches the fingerprint on that device:<br />{fp}
              </p>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={confirm} disabled={busy || selected.size === 0}>
            {enrolled ? 'Add selected' : 'Enable for selected'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCandidates(null)} disabled={busy}>Cancel</Button>
        </div>
      </div>
    )
  );

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Remote unlock &amp; wipe</h4>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Let a trusted device (e.g. your phone, with Paranoid Mode OFF) unlock this device from the
        lock screen — or wipe it if lost. You approve each unlock on the trusted device; nothing is
        typed here. Keeps the GitHub token readable while locked (see the security notes / threat model).
      </p>
      {enrolled ? (
        <>
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            Enabled — approver{approvers.length === 1 ? '' : 's'}: {approvers.map((a) => a.name).join(', ') || '(pending pickup)'}
          </p>
          {picker ?? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={loadCandidates} disabled={busy}>{busy ? 'Loading…' : 'Add another device'}</Button>
              <Button size="sm" variant="secondary" onClick={disable} disabled={busy}>Turn off</Button>
            </div>
          )}
        </>
      ) : picker ?? (
        <Button size="sm" variant="secondary" onClick={loadCandidates} disabled={busy}>
          {busy ? 'Loading…' : 'Set up remote unlock'}
        </Button>
      )}
    </div>
  );
}

// Every install can name itself; the name is published to the registry (shown to
// other devices when enrolling) and re-published on save.
function DeviceNameSection() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void (async () => setName(await getDeviceName()))(); }, []);

  async function save() {
    setBusy(true);
    try {
      await setDeviceName(name);
      const published = await publishOwnRegistryEntry();
      toast(published ? 'Device name saved' : 'Saved (will publish on next sync)', 'success');
    } catch (e) {
      recordError('remoteUnlock.setDeviceName', e);
      toast('Could not save the name', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Device name</h4>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Shown to your other devices when setting up remote unlock.
      </p>
      <div className="flex items-end gap-2">
        <Input label="This device's name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <Button size="sm" variant="secondary" onClick={save} disabled={busy}>Save</Button>
      </div>
    </div>
  );
}

function formatRemoteWipeTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// Approver side (this device is NOT Paranoid): manage devices it can unlock/wipe.
function ApproverDevicesSection() {
  const local = useLocalSettings();
  const [managed, setManaged] = useState<ManagedDevice[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => { setManaged(await listApprovedDevices()); }, []);
  useEffect(() => { void reload(); }, [reload]);

  const refreshStatuses = useCallback(async (quiet = false) => {
    if (!local.githubPat || !local.githubRepo) {
      if (!quiet) toast('Set up GitHub sync first', 'error');
      return;
    }
    if (!quiet) setBusy(true);
    try {
      const next = await refreshManagedDeviceWipeStatuses(local.githubPat, local.githubRepo);
      setManaged(next);
      if (!quiet) toast('Wipe status refreshed', 'info');
    } catch (e) {
      recordError('remoteUnlock.refreshWipeStatus', e);
      if (!quiet) toast(e instanceof Error ? e.message : 'Could not refresh wipe status', 'error');
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [local.githubPat, local.githubRepo]);

  useEffect(() => {
    if (!local.githubPat || !local.githubRepo || managed.length === 0) return;
    void refreshStatuses(true);
    const timer = setInterval(() => { void refreshStatuses(true); }, 12_000);
    return () => clearInterval(timer);
  }, [local.githubPat, local.githubRepo, managed.length, refreshStatuses]);

  async function checkInvites() {
    if (!local.githubPat || !local.githubRepo || !local.deviceId) { toast('Set up GitHub sync first', 'error'); return; }
    setBusy(true);
    try {
      const n = await pollApproverInbox(local.githubPat, local.githubRepo, local.deviceId);
      await reload();
      toast(n > 0 ? `Now trusted by ${n} device(s)` : 'No new invitations', 'info');
    } catch (e) {
      recordError('remoteUnlock.checkInvitations', e);
      toast(e instanceof Error ? e.message : 'Could not check invitations', 'error');
    } finally { setBusy(false); }
  }

  async function wipe(deviceId: string, name: string, resend = false) {
    const ok = await confirmDialog(`${resend ? 'Resend the remote wipe command to' : 'Remotely wipe'} “${name}”? Its local data is erased the next time it is online with the app open. Synced data is unaffected. Cannot be undone.`, { confirmLabel: resend ? 'Resend wipe command' : 'Send wipe command', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await sendRemoteWipe(local.githubPat!, local.githubRepo!, deviceId);
      await reload();
      toast('Wipe command sent', 'success');
    } catch (e) {
      recordError('remoteUnlock.sendWipe', e);
      toast(e instanceof Error ? e.message : 'Could not send wipe', 'error');
    } finally { setBusy(false); }
  }

  async function purge(deviceId: string, name: string) {
    const ok = await confirmDialog(`Purge “${name}” from all trusted devices? This removes it from every trusted device's list and best-effort deletes the remote wipe command/status and registry files. Synced task data is unaffected.`, { confirmLabel: 'Purge device', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await purgeManagedDevice(local.githubPat!, local.githubRepo!, deviceId);
      await reload();
      toast('Wiped device purged', 'success');
    } catch (e) {
      recordError('remoteUnlock.purgeManagedDevice', e);
      toast(e instanceof Error ? e.message : 'Could not purge device', 'error');
    } finally { setBusy(false); }
  }

  async function forgetPending(deviceId: string, name: string) {
    const ok = await confirmDialog(`Forget “${name}” from all trusted devices? The remote wipe command stays armed in GitHub, so the device can still wipe itself if it later comes online — but it is removed from every trusted device's list and no confirmation will be shown.`, { confirmLabel: 'Forget device', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await forgetManagedDeviceAfterWipeCommand(local.githubPat!, local.githubRepo!, deviceId);
      await reload();
      toast('Device forgotten; pending wipe command left in place', 'success');
    } catch (e) {
      recordError('remoteUnlock.forgetPendingWipeDevice', e);
      toast(e instanceof Error ? e.message : 'Could not forget device', 'error');
    } finally { setBusy(false); }
  }

  function wipeStatus(m: ManagedDevice): string {
    // "confirmed" comes from a device-signed wipe-status (authenticated). The pending
    // ("sent") line is derived from the shared, UNSIGNED command file and is advisory
    // only — the protected device verifies the approver signature before wiping, and
    // the confirmation below is the authenticated outcome (ACR-013).
    if (m.lastWipeAck) return `Wipe confirmed ${formatRemoteWipeTime(m.lastWipeAck.wipedAt)}`;
    if (m.lastWipeCommand) return `Wipe command sent ${formatRemoteWipeTime(m.lastWipeCommand.sentAt)} · unconfirmed (advisory)`;
    return 'No wipe command sent';
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Devices you can unlock &amp; wipe</h4>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Paranoid devices that trusted this one. You approve their unlock requests here, and can wipe
        a lost one. (A device in Paranoid Mode cannot act as an approver.)
      </p>
      {managed.length > 0 ? (
        <ul className="space-y-1">
          {managed.map((m) => (
            <li key={m.deviceId} className="flex flex-col gap-2 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{m.name}</p>
                  <p className={`text-[11px] ${m.lastWipeAck ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                    {wipeStatus(m)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button size="sm" variant="danger" onClick={() => wipe(m.deviceId, m.name, !!m.lastWipeCommand)} disabled={busy}>
                    {m.lastWipeCommand ? 'Resend' : 'Remote wipe'}
                  </Button>
                  {m.lastWipeAck && (
                    <Button size="sm" variant="secondary" onClick={() => purge(m.deviceId, m.name)} disabled={busy}>
                      Purge
                    </Button>
                  )}
                  {m.lastWipeCommand && !m.lastWipeAck && (
                    <Button size="sm" variant="secondary" onClick={() => forgetPending(m.deviceId, m.name)} disabled={busy}>
                      Forget
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">No devices yet.</p>
      )}
      <Button size="sm" variant="secondary" onClick={checkInvites} disabled={busy}>
        {busy ? 'Checking…' : 'Check for new invitations'}
      </Button>
      {managed.length > 0 && (
        <Button size="sm" variant="secondary" onClick={() => void refreshStatuses()} disabled={busy}>
          Refresh wipe status
        </Button>
      )}
    </div>
  );
}

export function SecuritySettings() {
  const { enabled, hasSecurityKey } = useVault();
  const local = useLocalSettings();
  if (!enabled) {
    return (
      <div className="space-y-4">
        <EnableForm />
        <DeviceNameSection />
        <ApproverDevicesSection />
      </div>
    );
  }
  return (
    <ManageForm
      idleMinutes={local.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES}
      maxAttempts={local.paranoidMaxUnlockAttempts ?? DEFAULT_MAX_ATTEMPTS}
      systemIdleOn={!!local.paranoidSystemIdleLock}
      systemLockGraceOn={!!local.paranoidSystemLockGraceEnabled}
      systemLockGraceMinutes={local.paranoidSystemLockGraceMinutes ?? DEFAULT_SYSTEM_LOCK_GRACE_MINUTES}
      hasSecurityKey={hasSecurityKey}
    />
  );
}
