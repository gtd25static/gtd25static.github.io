import { useState } from 'react';
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
  DEFAULT_IDLE_MINUTES, DEFAULT_MAX_ATTEMPTS,
} from '../../db/vault';
import { isWebAuthnSupported } from '../../sync/webauthn-prf';
import { panicWipe } from '../../lib/panic-wipe';
import { exportToZip } from '../../db/export-import';

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
  const available = isWebAuthnSupported();

  async function handleAdd() {
    setBusy(true);
    try {
      await addSecurityKey();
      toast('Security key added', 'success');
    } catch (e) {
      // registerPrfCredential throws a specific reason (cancelled / unsupported /
      // empty PRF). NotAllowedError = the user dismissed the prompt.
      const msg = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Security key setup was cancelled'
        : e instanceof Error ? e.message : 'Could not add the security key';
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    const ok = await confirmDialog(
      'Remove the security key? You will need your passphrase to unlock this device.',
      { confirmLabel: 'Remove', danger: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await removeSecurityKey();
      toast('Security key removed', 'success');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Security key</h4>
      {hasSecurityKey ? (
        <>
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            Enabled — unlock by touching your FIDO2 security key (no typing, so a keylogger sees nothing).
          </p>
          <Button size="sm" variant="secondary" onClick={handleRemove} disabled={busy}>Remove security key</Button>
        </>
      ) : available ? (
        <>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Add a FIDO2 security key (e.g. a YubiKey) as a keylogger-safe unlock. Plug it in, then
            click below. Your passphrase still works as a fallback.
          </p>
          <Button size="sm" variant="secondary" onClick={handleAdd} disabled={busy}>
            {busy ? 'Waiting for security key…' : 'Add security key'}
          </Button>
        </>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Security keys are not supported in this browser.
        </p>
      )}
    </div>
  );
}

function SystemIdleToggle({ enabled }: { enabled: boolean }) {
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
        </>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Not available in this browser (Chrome/Edge only). The in-app idle timer still applies.
        </p>
      )}
    </div>
  );
}

function ManageForm({ idleMinutes, maxAttempts, systemIdleOn, hasSecurityKey }: { idleMinutes: number; maxAttempts: number; systemIdleOn: boolean; hasSecurityKey: boolean }) {
  const [idle, setIdle] = useState(String(idleMinutes));
  const [attempts, setAttempts] = useState(String(maxAttempts));
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [busy, setBusy] = useState(false);

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
      else toast(`${unreadable} of ${total} items unreadable — re-sync from another device to recover`, 'error');
    } catch (e) {
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

      <SystemIdleToggle enabled={systemIdleOn} />

      <SecurityKeySection hasSecurityKey={hasSecurityKey} />

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

export function SecuritySettings() {
  const { enabled, hasSecurityKey } = useVault();
  const local = useLocalSettings();
  if (!enabled) return <EnableForm />;
  return (
    <ManageForm
      idleMinutes={local.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES}
      maxAttempts={local.paranoidMaxUnlockAttempts ?? DEFAULT_MAX_ATTEMPTS}
      systemIdleOn={!!local.paranoidSystemIdleLock}
      hasSecurityKey={hasSecurityKey}
    />
  );
}
