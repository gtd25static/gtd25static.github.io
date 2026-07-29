// @vitest-environment jsdom
import { render, screen, waitFor, act } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { SHARE_META_PATH, SHARE_STASH_TTL_MS, hasFreshShareStash, type SharedPayloadMeta } from '../../lib/share-target';

// The lock screen must render WITHOUT the vault: stub the modules it calls into so
// this stays a UI test of the "share waiting" notice, not an Argon2id round trip
// (lockscreen-flow.test.tsx covers the real unlock).
vi.mock('../../db/vault', () => ({
  unlockWithPassphrase: vi.fn(async () => true),
  unlockWithSecurityKey: vi.fn(async () => true),
  refreshSecurityKeyFlag: vi.fn(async () => false),
  getLastUnlockFailure: () => null,
}));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ enabled: true, unlocked: false, locked: true, hasSecurityKey: false }) }));
vi.mock('../../hooks/use-remote-unlock', () => ({ useLockScreenRemote: () => ({ enrolled: false, code: null, error: '', request: vi.fn(), cancel: vi.fn() }) }));
vi.mock('../../hooks/use-service-worker', () => ({ useServiceWorker: () => ({ forceCheck: vi.fn() }) }));
vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));

import { LockScreen } from '../../components/security/LockScreen';

/** Cache Storage holding (or not) a stash written by the SW while the app was locked. */
function installCaches(meta: SharedPayloadMeta | null) {
  let opened = false;
  (globalThis as unknown as { caches: unknown }).caches = {
    has: async () => meta !== null,
    open: async () => {
      opened = true;
      return { match: async (req: unknown) => (meta && String(req) === SHARE_META_PATH ? { json: async () => meta } : undefined) };
    },
    delete: async () => false,
  };
  return { wasOpened: () => opened };
}

const meta = (over: Partial<SharedPayloadMeta> = {}): SharedPayloadMeta => ({
  title: 'Secret plan', text: 'the body', url: 'https://example.com/private', ts: Date.now(),
  files: [{ name: 'passport-scan.png', type: 'image/png', size: 10 }],
  ...over,
});

const NOTICE = /Shared content is waiting/;

beforeEach(() => { window.history.replaceState({}, '', '/?shareTarget=1'); });
afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; });

describe('share received while the vault is locked', () => {
  it('tells the user on the lock screen that a share is being held', async () => {
    installCaches(meta());
    render(<LockScreen />);
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it('leaks no shared content onto the lock screen — presence only', async () => {
    installCaches(meta());
    render(<LockScreen />);
    await screen.findByText(NOTICE);
    for (const secret of ['Secret plan', 'the body', 'example.com', 'passport-scan.png']) {
      expect(document.body.textContent).not.toContain(secret);
    }
  });

  it('says nothing when no share is waiting, and never creates the cache', async () => {
    const caches = installCaches(null);
    render(<LockScreen />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(caches.wasOpened()).toBe(false);
  });

  it('says nothing for a stash already past its TTL (it will be purged, not filed)', async () => {
    installCaches(meta({ ts: Date.now() - SHARE_STASH_TTL_MS - 60_000 }));
    render(<LockScreen />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('notices a share that lands while the lock screen is already open', async () => {
    installCaches(null);
    render(<LockScreen />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(NOTICE)).toBeNull();

    installCaches(meta()); // SW stashed a new share while this screen was backgrounded
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(screen.getByText(NOTICE)).toBeInTheDocument());
  });

  it('probe survives a broken Cache Storage instead of blocking the lock screen', async () => {
    (globalThis as unknown as { caches: unknown }).caches = { has: async () => { throw new Error('nope'); } };
    expect(await hasFreshShareStash()).toBe(false);
    render(<LockScreen />);
    expect(screen.getByText('Vault locked')).toBeInTheDocument();
  });
});
