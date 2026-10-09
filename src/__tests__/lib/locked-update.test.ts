const h = vi.hoisted(() => ({
  unlocking: false,
  requestLive: false,
  ambient: false,
  others: false as boolean | null,
}));
vi.mock('../../db/vault', () => ({ isUnlocking: () => h.unlocking }));
vi.mock('../../sync/remote-unlock', () => ({ isUnlockRequestLive: () => h.requestLive }));
vi.mock('../../stores/pomodoro-store', () => ({ usePomodoroStore: { getState: () => ({ ambientPlaying: h.ambient }) } }));
vi.mock('../../lib/unlocked-presence', () => ({ anyTabUnlocked: async () => h.others }));

import { safeToUpdateWhileLocked } from '../../lib/locked-update';
import {
  setLockScreenState, noteLockScreenInput, lockScreenInUse, __resetLockScreenActivityForTests,
} from '../../lib/lock-screen-activity';

beforeEach(() => {
  Object.assign(h, { unlocking: false, requestLive: false, ambient: false, others: false });
  __resetLockScreenActivityForTests();
});

describe('lock-screen activity', () => {
  it('in use while something is typed, a wipe is being confirmed, or for 10 s after a touch', () => {
    const now = 1_000_000;
    expect(lockScreenInUse(now)).toBe(false);
    setLockScreenState({ typed: true, confirmingWipe: false });
    expect(lockScreenInUse(now)).toBe(true);
    setLockScreenState({ typed: false, confirmingWipe: true });
    expect(lockScreenInUse(now)).toBe(true);
    setLockScreenState({ typed: false, confirmingWipe: false });
    noteLockScreenInput(now);
    expect(lockScreenInUse(now + 9_999)).toBe(true);
    expect(lockScreenInUse(now + 10_000)).toBe(false);
  });
});

describe('safeToUpdateWhileLocked', () => {
  it('yes with nobody on the lock screen, no unlock under way, nothing playing and no other tab open', async () => {
    expect(await safeToUpdateWhileLocked()).toBe(true);
  });

  it.each([
    ['an unlock is under way (Argon2, or the work after it)', () => { h.unlocking = true; }],
    ['a trusted device may be about to approve', () => { h.requestLive = true; }],
    ['the passphrase field has text in it', () => setLockScreenState({ typed: true, confirmingWipe: false })],
    ['a wipe is being confirmed', () => setLockScreenState({ typed: false, confirmingWipe: true })],
    ['the lock screen was just touched', () => noteLockScreenInput()],
    ['the ambient sound is playing', () => { h.ambient = true; }],
    ['another tab is unlocked', () => { h.others = true; }],
    ['this browser cannot tell about other tabs', () => { h.others = null; }],
  ])('no while %s', async (_why, arrange) => {
    arrange();
    expect(await safeToUpdateWhileLocked()).toBe(false);
  });
});
