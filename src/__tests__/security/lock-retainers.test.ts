// Things that held decrypted content past a lock.
//
// Locking drops the DEK, the sync key and the cached secrets — but two retainers
// outlived it: the text kept for the clipboard auto-clear's comparison (up to the
// full 5-minute delay) and the object URL a shared-folder download keeps alive
// for a minute, which stays resolvable from any same-origin context.
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, __resetVaultStateForTests } from '../../db/vault';
import { startForgettingSessionOnLock } from '../../lib/forget-on-lock';
import {
  writeTextWithHygiene, __resetClipboardHygieneForTests, __pendingClipboardTextForTests,
} from '../../lib/clipboard-hygiene';
import {
  createSessionObjectUrl, revokeSessionObjectUrls, __openSessionObjectUrlCount,
} from '../../lib/session-object-urls';

const PASS = 'lock retainers passphrase 42';

let revoked: string[] = [];

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  __resetClipboardHygieneForTests();
  revokeSessionObjectUrls();
  revoked = [];
  localStorage.removeItem('gtd25-paranoid');
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:fake-${Math.random()}`,
    revokeObjectURL: (u: string) => { revoked.push(u); },
  }));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  __resetVaultStateForTests();
  vi.unstubAllGlobals();
  localStorage.removeItem('gtd25-paranoid');
});

describe('object URLs holding decrypted bytes', () => {
  it('revokes them on lock instead of waiting out the TTL', () => {
    const stop = startForgettingSessionOnLock();
    const url = createSessionObjectUrl(new Blob(['x']), 60_000);
    expect(__openSessionObjectUrlCount()).toBe(1);

    revokeSessionObjectUrls();

    expect(revoked).toContain(url);
    expect(__openSessionObjectUrlCount()).toBe(0);
    stop();
  });

  it('still revokes on its own when no lock intervenes', () => {
    vi.useFakeTimers();
    const url = createSessionObjectUrl(new Blob(['x']), 60_000);
    vi.advanceTimersByTime(60_001);
    expect(revoked).toContain(url);
    expect(__openSessionObjectUrlCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('clipboard auto-clear retention', () => {
  it('drops the copied text when the vault locks', async () => {
    await enableParanoid(PASS);
    await db.localSettings.update('local', { paranoidClipboardClearEnabled: true });
    const stop = startForgettingSessionOnLock();

    await writeTextWithHygiene('REAL_COPIED_CONTENT');
    // scheduleClear reads settings asynchronously before retaining.
    await vi.waitFor(() => expect(__pendingClipboardTextForTests()).toBe('REAL_COPIED_CONTENT'));

    lock();

    expect(__pendingClipboardTextForTests()).toBeNull();
    stop();
  });
});
