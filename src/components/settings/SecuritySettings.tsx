import { useEffect, useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useVault } from '../../hooks/use-vault';
import { useLocalSettings } from '../../hooks/use-settings';
import {
  enableParanoid, disableParanoid, changePassphrase, configureIdleTimeout, lock,
  addBiometric, removeBiometric, DEFAULT_IDLE_MINUTES,
} from '../../db/vault';
import { isPlatformAuthenticatorAvailable } from '../../sync/webauthn-prf';
import { panicWipe } from '../../lib/panic-wipe';

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

function BiometricSection({ hasBiometric }: { hasBiometric: boolean }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    isPlatformAuthenticatorAvailable().then((ok) => { if (active) setAvailable(ok); });
    return () => { active = false; };
  }, []);

  async function handleAdd() {
    setBusy(true);
    try {
      await addBiometric();
      toast('Biometric unlock added', 'success');
    } catch (e) {
      // registerPrfCredential throws a specific reason (cancelled / unsupported /
      // empty PRF). NotAllowedError = the user dismissed the prompt.
      const msg = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Biometric setup was cancelled'
        : e instanceof Error ? e.message : 'Could not add biometric unlock';
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    const ok = await confirmDialog(
      'Remove biometric unlock? You will need your passphrase to unlock this device.',
      { confirmLabel: 'Remove', danger: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await removeBiometric();
      toast('Biometric unlock removed', 'success');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <h4 className="text-sm font-medium">Biometric unlock</h4>
      {hasBiometric ? (
        <>
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            Enabled — unlock with Windows Hello / Touch ID on this device.
          </p>
          <Button size="sm" variant="secondary" onClick={handleRemove} disabled={busy}>Remove biometric</Button>
        </>
      ) : available ? (
        <>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Add your device biometric (Windows Hello / Touch ID) as a faster unlock. Your passphrase
            still works as a fallback.
          </p>
          <Button size="sm" variant="secondary" onClick={handleAdd} disabled={busy}>
            {busy ? 'Waiting for biometric…' : 'Add biometric unlock'}
          </Button>
        </>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          No biometric authenticator is available on this device.
        </p>
      )}
    </div>
  );
}

function ManageForm({ idleMinutes, hasBiometric }: { idleMinutes: number; hasBiometric: boolean }) {
  const [idle, setIdle] = useState(String(idleMinutes));
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSaveIdle() {
    await configureIdleTimeout(clampMinutes(idle));
    setIdle(String(clampMinutes(idle)));
    toast('Auto-lock updated', 'success');
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

      <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <Input label="New passphrase" type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Change passphrase" disabled={busy} />
        <Input label="Confirm new passphrase" type="password" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} placeholder="Repeat new passphrase" disabled={busy} />
        <Button size="sm" variant="secondary" onClick={handleChangePass} disabled={busy}>Change passphrase</Button>
      </div>

      <BiometricSection hasBiometric={hasBiometric} />

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
  const { enabled, hasBiometric } = useVault();
  const local = useLocalSettings();
  if (!enabled) return <EnableForm />;
  return (
    <ManageForm
      idleMinutes={local.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES}
      hasBiometric={hasBiometric}
    />
  );
}
