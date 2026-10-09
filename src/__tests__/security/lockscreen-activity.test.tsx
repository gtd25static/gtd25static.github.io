// @vitest-environment jsdom
//
// The lock screen tells the update a locked device applies on its own (lib/
// locked-update) when someone is using it, so the reload never lands on a
// passphrase being typed or a wipe being confirmed.
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup-component';

vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ enabled: true, unlocked: false, locked: true, hasSecurityKey: false, busy: false }) }));
vi.mock('../../hooks/use-remote-unlock', () => ({ useLockScreenRemote: () => ({ enrolled: false, code: null, error: null, request: vi.fn(), cancel: vi.fn() }) }));
vi.mock('../../hooks/use-service-worker', () => ({ useServiceWorker: () => ({ forceCheck: vi.fn() }) }));
vi.mock('../../db/vault', () => ({
  unlockWithPassphrase: vi.fn(async () => false),
  unlockWithSecurityKey: vi.fn(async () => false),
  refreshSecurityKeyFlag: vi.fn(async () => false),
  getLastUnlockFailure: () => null,
}));
vi.mock('../../lib/share-target', () => ({
  hasFreshShareStash: vi.fn(async () => false),
  purgeExpiredShareStash: vi.fn(async () => undefined),
  SHARE_STASH_TTL_MS: 24 * 3_600_000,
}));
vi.mock('../../lib/panic-wipe', () => ({ panicWipe: vi.fn() }));
vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));

import { LockScreen } from '../../components/security/LockScreen';
import { lockScreenInUse, __resetLockScreenActivityForTests } from '../../lib/lock-screen-activity';

const LATER = () => Date.now() + 60_000; // past the "touched a moment ago" window

beforeEach(() => __resetLockScreenActivityForTests());

describe('LockScreen reports when it is in use', () => {
  it('while the passphrase field has text, and not once it is empty again', () => {
    render(<LockScreen />);
    expect(lockScreenInUse(LATER())).toBe(false);
    const field = screen.getByLabelText('Passphrase');
    fireEvent.change(field, { target: { value: 'half typed' } });
    expect(lockScreenInUse(LATER())).toBe(true);
    fireEvent.change(field, { target: { value: '' } });
    expect(lockScreenInUse(LATER())).toBe(false);
  });

  it('while a wipe is being confirmed', () => {
    render(<LockScreen />);
    fireEvent.click(screen.getByRole('button', { name: /wipe this device/i }));
    expect(lockScreenInUse(LATER())).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(lockScreenInUse(LATER())).toBe(false);
  });

  it('for a moment after any touch or key on it', () => {
    render(<LockScreen />);
    expect(lockScreenInUse()).toBe(false);
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Vault locked' }));
    expect(lockScreenInUse()).toBe(true);
  });

  it('not once it is gone (unlocked) with text still in the field', () => {
    const { unmount } = render(<LockScreen />);
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'x' } });
    unmount();
    expect(lockScreenInUse(LATER())).toBe(false);
  });
});
