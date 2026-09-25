import type { LocalSettings } from '../../db/models';
import { db } from '../../db';
import { confirmCurrentPassphrase, isParanoidEnabled } from '../../db/vault';
import { updateLocalSettings } from '../../hooks/use-settings';
import { recordError } from '../../lib/diagnostics';
import { weakensProtection } from '../../lib/security-weakening';
import { promptPassword } from '../ui/PasswordPrompt';
import { toast } from '../ui/Toast';

// The gate in front of anything that changes how this vault opens — and, on a
// Paranoid device, anything that loosens its protection or points its sync
// somewhere else: an unlocked but unattended session must not be enough.
// Returns the passphrase (a follow-up may need it — a re-key) or null when
// cancelled or not the main passphrase; the toast is already shown. The
// secondary passphrase is refused here like any other wrong one.
export async function requirePassphrase(reason: string): Promise<string | null> {
  const typed = await promptPassword('Confirm your passphrase', {
    message: reason, confirmLabel: 'Continue', placeholder: 'Vault passphrase',
  });
  if (typed === null) return null;
  let ok = false;
  try {
    ok = await confirmCurrentPassphrase(typed);
  } catch (e) {
    recordError('security.confirmPassphrase', e);
    toast(e instanceof Error ? e.message : 'Could not check the passphrase', 'error');
    return null;
  }
  if (!ok) {
    toast('Incorrect passphrase', 'error');
    return null;
  }
  return typed;
}

/**
 * Save Paranoid-related settings, asking for the passphrase first when the
 * change loosens the device's protection (see lib/security-weakening). Returns
 * whether it was applied. Tightening, and any change without Paranoid Mode, is
 * saved directly.
 */
export async function updateSecuritySettings(changes: Partial<LocalSettings>): Promise<boolean> {
  const current = await db.localSettings.get('local');
  if (current && isParanoidEnabled() && weakensProtection(current, changes)
    && await requirePassphrase('Your passphrase is needed to loosen this device’s protection.') === null) {
    return false;
  }
  await updateLocalSettings(changes);
  return true;
}
