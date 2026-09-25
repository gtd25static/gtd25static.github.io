// @vitest-environment jsdom
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';

const h = vi.hoisted(() => ({
  paranoid: true,
  prompt: vi.fn(async (): Promise<string | null> => 'typed'),
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
}));
vi.mock('../../db/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/vault')>()),
  isParanoidEnabled: () => h.paranoid,
  confirmCurrentPassphrase: h.confirm,
}));
vi.mock('../../components/ui/PasswordPrompt', () => ({ promptPassword: h.prompt }));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));

import { updateSecuritySettings } from '../../components/settings/passphrase-gate';

// On a Paranoid device, an unlocked but unattended session must not be able to
// switch protections off, lengthen delays or clear the unlock log without the
// passphrase (GUI review). Tightening never asks.

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  h.paranoid = true;
  h.prompt.mockResolvedValue('typed');
  h.confirm.mockResolvedValue(true);
  await db.localSettings.update('local', { paranoidLockHotkeyEnabled: true, paranoidBackgroundLockSeconds: 10 });
});

const setting = async () => db.localSettings.get('local');

describe('updateSecuritySettings', () => {
  it('asks for the passphrase before loosening, and applies it once confirmed', async () => {
    expect(await updateSecuritySettings({ paranoidLockHotkeyEnabled: false })).toBe(true);
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.confirm).toHaveBeenCalledWith('typed');
    expect((await setting())?.paranoidLockHotkeyEnabled).toBe(false);
  });

  it('changes nothing when the prompt is cancelled or the passphrase is wrong', async () => {
    h.prompt.mockResolvedValueOnce(null);
    expect(await updateSecuritySettings({ paranoidBackgroundLockSeconds: 300 })).toBe(false);
    h.confirm.mockResolvedValueOnce(false);
    expect(await updateSecuritySettings({ paranoidBackgroundLockSeconds: 300 })).toBe(false);
    expect((await setting())?.paranoidBackgroundLockSeconds).toBe(10);
    expect(h.toast).toHaveBeenCalledWith('Incorrect passphrase', 'error');
  });

  it('never asks to tighten', async () => {
    expect(await updateSecuritySettings({ paranoidBackgroundLockSeconds: 0, paranoidRedactModeEnabled: true })).toBe(true);
    expect(h.prompt).not.toHaveBeenCalled();
    expect((await setting())?.paranoidBackgroundLockSeconds).toBe(0);
  });

  it('never asks on a device without Paranoid Mode (there is no passphrase)', async () => {
    h.paranoid = false;
    expect(await updateSecuritySettings({ paranoidLockHotkeyEnabled: false })).toBe(true);
    expect(h.prompt).not.toHaveBeenCalled();
  });
});
