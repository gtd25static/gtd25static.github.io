import { useState, useEffect, useCallback } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useVault } from '../../hooks/use-vault';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import { isSystemIdleSupported, requestSystemIdlePermission } from '../../lib/system-idle';
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

function SystemIdleToggle({ enabled, graceEnabled }: { enabled: boolean; graceEnabled: boolean }) {
  const supported = isSystemIdleSupported();
  const [busy, setBusy] = useState(false);

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
            <label className="flex items-start gap-2 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800/40 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={graceEnabled}
                onChange={async (e) => {
                  const enabled = e.currentTarget.checked;
                  await updateLocalSettings({ paranoidSystemLockGraceEnabled: enabled });
                  toast(
                    enabled
                      ? 'Will wait 10 minutes after screen lock before locking GTD25'
                      : 'Will lock GTD25 immediately on screen lock',
                    'success',
                  );
                }}
                className="mt-0.5 rounded accent-accent-600"
              />
              <span>
                Delay GTD25 lock for 10 minutes after screen lock
                <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                  Avoids a full app unlock for brief macOS locks. System idle still locks normally.
                </span>
              </span>
            </label>
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

function ManageForm({ idleMinutes, maxAttempts, systemIdleOn, systemLockGraceOn, hasSecurityKey }: { idleMinutes: number; maxAttempts: number; systemIdleOn: boolean; systemLockGraceOn: boolean; hasSecurityKey: boolean }) {
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
        <Input label="Confirm new passphrase" type="password" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder="Repeat new passphrase" disabled={busy} />
        <Button size="sm" variant="secondary" onClick={handleChangePass} disabled={busy}>Change passphrase</Button>
      </div>

      <SystemIdleToggle enabled={systemIdleOn} graceEnabled={systemLockGraceOn} />

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
    const ok = await confirmDialog(`Purge “${name}” from this trusted device? This removes the local management entry and best-effort deletes remote wipe command/status files. Synced task data is unaffected.`, { confirmLabel: 'Purge device', danger: true });
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
    const ok = await confirmDialog(`Forget “${name}” from this trusted device? The remote wipe command stays in GitHub, so the device can still wipe itself if it later comes online. You will no longer see confirmation here.`, { confirmLabel: 'Forget device', danger: true });
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
    if (m.lastWipeAck) return `Wipe confirmed ${formatRemoteWipeTime(m.lastWipeAck.wipedAt)}`;
    if (m.lastWipeCommand) return `Wipe command sent ${formatRemoteWipeTime(m.lastWipeCommand.sentAt)} · awaiting confirmation`;
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
      hasSecurityKey={hasSecurityKey}
    />
  );
}
