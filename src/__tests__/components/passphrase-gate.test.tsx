// @vitest-environment jsdom
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';

const h = vi.hoisted(() => ({
  paranoid: true,
  prompt: vi.fn(async (): Promise<string | null> => 'typed'),
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
  ALT: Symbol('alternative'),
  promptAlt: vi.fn(async (): Promise<string | symbol | null> => null),
  keyEnrolled: false,
  confirmKey: vi.fn(async () => true),
}));
vi.mock('../../db/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/vault')>()),
  isParanoidEnabled: () => h.paranoid,
  confirmCurrentPassphrase: h.confirm,
  getVaultSnapshot: () => ({ enabled: true, unlocked: true, hasSecurityKey: h.keyEnrolled, busy: false }),
  confirmOwnerWithSecurityKey: h.confirmKey,
}));
vi.mock('../../components/ui/PasswordPrompt', () => ({
  promptPassword: h.prompt, promptPasswordOrAlternative: h.promptAlt, ALTERNATIVE: h.ALT,
}));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));

import { updateSecuritySettings, requireOwner } from '../../components/settings/passphrase-gate';

// On a Paranoid device, an unlocked but unattended session must not be able to
// switch protections off, lengthen delays or clear the unlock log without the
// passphrase (GUI review). Tightening never asks.

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  h.paranoid = true;
  h.keyEnrolled = false;
  h.confirmKey.mockResolvedValue(true);
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

describe('requireOwner — a security key instead of the passphrase (threat-model review, batch 5)', () => {
  // Gated changes made a security-key user type the passphrase on whatever
  // machine they were on — the one thing the key is there to avoid.
  it('offers the key when one is enrolled, and a touch of it is enough', async () => {
    h.keyEnrolled = true;
    h.promptAlt.mockResolvedValueOnce(h.ALT);
    expect(await requireOwner('Your passphrase is needed to lengthen the auto-lock.')).toBe(true);
    expect(h.promptAlt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ alternativeLabel: 'Use security key' }));
    expect(h.confirmKey).toHaveBeenCalledOnce();
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('a key that does not confirm it is refused', async () => {
    h.keyEnrolled = true;
    h.promptAlt.mockResolvedValueOnce(h.ALT);
    h.confirmKey.mockResolvedValueOnce(false);
    expect(await requireOwner('x')).toBe(false);
    expect(h.toast).toHaveBeenCalledWith('The security key did not confirm it', 'error');
  });

  it('the passphrase still works from the same prompt', async () => {
    h.keyEnrolled = true;
    h.promptAlt.mockResolvedValueOnce('typed');
    expect(await requireOwner('x')).toBe(true);
    expect(h.confirm).toHaveBeenCalledWith('typed');
  });

  it('without a key enrolled it is the plain passphrase prompt', async () => {
    expect(await requireOwner('x')).toBe(true);
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.promptAlt).not.toHaveBeenCalled();
  });
});
