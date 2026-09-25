import { weakensProtection } from '../../lib/security-weakening';
import type { LocalSettings } from '../../db/models';

// An unlocked but unattended Paranoid session could quietly loosen the device's
// protection — longer delays, protections switched off, the unlock log cleared —
// without the passphrase that every change to how the vault OPENS already asks
// for (GUI review). Loosening now asks for it too; tightening never does.

const base = { id: 'local' } as LocalSettings;

describe('weakensProtection', () => {
  it.each([
    'paranoidSystemIdleLock', 'paranoidPrivacyOverlayEnabled', 'paranoidPrivacyOverlayImmediate',
    'paranoidBackgroundLockEnabled', 'paranoidLockHotkeyEnabled', 'paranoidRedactModeEnabled',
    'paranoidUnlockLogEnabled', 'paranoidClipboardClearEnabled',
  ] as const)('turning %s off loosens; turning it on does not', (key) => {
    expect(weakensProtection({ ...base, [key]: true }, { [key]: false })).toBe(true);
    expect(weakensProtection({ ...base, [key]: false }, { [key]: true })).toBe(false);
    expect(weakensProtection({ ...base }, { [key]: true })).toBe(false);
  });

  it.each(['paranoidSystemLockGraceEnabled', 'relaxedUnlockEnabled'] as const)(
    'turning %s on loosens; turning it off does not', (key) => {
      expect(weakensProtection({ ...base }, { [key]: true })).toBe(true);
      expect(weakensProtection({ ...base, [key]: true }, { [key]: false })).toBe(false);
    },
  );

  it.each([
    ['paranoidBackgroundLockSeconds', 30],
    ['paranoidSystemLockGraceMinutes', 10],
    ['paranoidClipboardClearSeconds', 60],
  ] as const)('a longer %s loosens, a shorter or equal one does not (unset reads as the default)', (key, fallback) => {
    expect(weakensProtection({ ...base, [key]: 20 }, { [key]: 40 })).toBe(true);
    expect(weakensProtection({ ...base, [key]: 40 }, { [key]: 20 })).toBe(false);
    expect(weakensProtection({ ...base, [key]: 40 }, { [key]: 40 })).toBe(false);
    expect(weakensProtection({ ...base }, { [key]: fallback + 1 })).toBe(true);
    expect(weakensProtection({ ...base }, { [key]: fallback - 1 })).toBe(false);
  });

  it('anything unrelated, or a tightening mixed with nothing looser, needs no passphrase', () => {
    expect(weakensProtection(base, { deviceName: 'Phone' } as Partial<LocalSettings>)).toBe(false);
    expect(weakensProtection(base, { paranoidLockHotkeyEnabled: true, paranoidBackgroundLockSeconds: 0 })).toBe(false);
  });

  it('one looser change in a batch is enough', () => {
    expect(weakensProtection({ ...base, paranoidRedactModeEnabled: true }, {
      paranoidLockHotkeyEnabled: true, paranoidRedactModeEnabled: false,
    })).toBe(true);
  });
});
