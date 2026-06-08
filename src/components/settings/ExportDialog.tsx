import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { exportToZip, type ExportKeySource } from '../../db/export-import';
import { toast } from '../ui/Toast';
import { recordError } from '../../lib/diagnostics';

type Mode = 'plain' | 'passphrase' | 'sync';

interface Props {
  open: boolean;
  onClose: () => void;
  // The current sync/encryption password, if one is available to encrypt with.
  syncPassword?: string;
  // Default to encrypted selection (e.g. in Paranoid Mode).
  defaultEncrypted: boolean;
}

export function ExportDialog({ open, onClose, syncPassword, defaultEncrypted }: Props) {
  const syncPasswordAvailable = !!syncPassword;
  const [mode, setMode] = useState<Mode>(defaultEncrypted ? 'passphrase' : 'plain');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setPassword('');
    setConfirm('');
    setError('');
  }

  async function handleExport() {
    setError('');
    let encrypt: { password: string; keySource: ExportKeySource } | undefined;
    if (mode === 'passphrase') {
      if (!password) { setError('Enter a passphrase'); return; }
      if (password !== confirm) { setError('Passphrases do not match'); return; }
      encrypt = { password, keySource: 'passphrase' };
    } else if (mode === 'sync') {
      if (!syncPassword) { setError('No sync password available'); return; }
      encrypt = { password: syncPassword, keySource: 'sync' };
    }

    setBusy(true);
    try {
      const blob = await exportToZip(encrypt ? { encrypt } : undefined);
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gtd25-backup-${date}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      reset();
      onClose();
    } catch (err) {
      console.error('Export failed:', err);
      recordError('backups.export', err);
      setError(err instanceof Error ? err.message : 'Export failed');
      toast('Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export backup">
      <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="export-mode" checked={mode === 'plain'} onChange={() => setMode('plain')} className="mt-1" />
          <span>
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Unencrypted</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">Plain zip. Anyone with the file can read it.</span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="export-mode" checked={mode === 'passphrase'} onChange={() => setMode('passphrase')} className="mt-1" />
          <span>
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Encrypted with a passphrase</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">You choose a passphrase; you'll need it to import.</span>
          </span>
        </label>

        <label className={`flex items-start gap-2 text-sm ${syncPasswordAvailable ? '' : 'opacity-50'}`}>
          <input type="radio" name="export-mode" checked={mode === 'sync'} onChange={() => setMode('sync')} disabled={!syncPasswordAvailable} className="mt-1" />
          <span>
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Encrypted with your sync password</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              {syncPasswordAvailable ? 'No passphrase to remember; uses your existing sync password.' : 'Set up sync encryption first to use this.'}
            </span>
          </span>
        </label>

        {mode === 'passphrase' && (
          <div className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/40">
            <Input label="Passphrase" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <Input label="Confirm passphrase" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleExport} disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
