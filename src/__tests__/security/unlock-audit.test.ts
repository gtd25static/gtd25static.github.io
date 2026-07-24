import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  MAX_UNLOCK_LOG,
  recordUnlockAttempt,
  clearUnlockLog,
  failedSinceLastSuccess,
  failedEntriesSinceLastSuccess,
  previousSuccess,
  type UnlockLogEntry,
} from '../../lib/unlock-audit';

const ok = (at: number, method: UnlockLogEntry['method'] = 'passphrase'): UnlockLogEntry => ({ at, method, ok: true });
const fail = (at: number): UnlockLogEntry => ({ at, method: 'passphrase', ok: false });

async function setLocal(patch: Record<string, unknown>) {
  await db.localSettings.put({ id: 'local', syncEnabled: false, syncIntervalMs: 300_000, ...patch });
}

beforeEach(async () => {
  await resetDb();
});

describe('recordUnlockAttempt', () => {
  it('does nothing unless the feature is enabled', async () => {
    await setLocal({ paranoidUnlockLogEnabled: false });
    await recordUnlockAttempt('passphrase', true, 1000);
    expect((await db.localSettings.get('local'))?.unlockLog).toBeUndefined();
  });

  it('appends successes and failures once enabled', async () => {
    await setLocal({ paranoidUnlockLogEnabled: true });
    await recordUnlockAttempt('passphrase', false, 1000);
    await recordUnlockAttempt('securityKey', true, 2000);
    const log = (await db.localSettings.get('local'))!.unlockLog!;
    expect(log).toEqual([
      { at: 1000, method: 'passphrase', ok: false },
      { at: 2000, method: 'securityKey', ok: true },
    ]);
  });

  it('caps the log at MAX_UNLOCK_LOG, keeping the most recent', async () => {
    await setLocal({ paranoidUnlockLogEnabled: true });
    for (let i = 0; i < MAX_UNLOCK_LOG + 10; i++) await recordUnlockAttempt('passphrase', true, i);
    const log = (await db.localSettings.get('local'))!.unlockLog!;
    expect(log).toHaveLength(MAX_UNLOCK_LOG);
    expect(log[0].at).toBe(10); // first 10 dropped
    expect(log.at(-1)!.at).toBe(MAX_UNLOCK_LOG + 9);
  });

  it('clearUnlockLog empties it', async () => {
    await setLocal({ paranoidUnlockLogEnabled: true, unlockLog: [ok(1)] });
    await clearUnlockLog();
    expect((await db.localSettings.get('local'))!.unlockLog).toEqual([]);
  });
});

describe('failedSinceLastSuccess', () => {
  it('counts trailing failures back to the last success', () => {
    expect(failedSinceLastSuccess([ok(1), fail(2), fail(3)])).toBe(2);
    expect(failedSinceLastSuccess([ok(1), ok(2)])).toBe(0);
    expect(failedSinceLastSuccess([fail(1), fail(2)])).toBe(2); // never any success
    expect(failedSinceLastSuccess([])).toBe(0);
  });
});

describe('failedEntriesSinceLastSuccess', () => {
  it('returns the trailing failures themselves, oldest first', () => {
    const log = [ok(1), fail(20), fail(30)];
    expect(failedEntriesSinceLastSuccess(log)).toEqual([fail(20), fail(30)]);
  });

  it('keeps each attempt’s method so the alert can show how it was tried', () => {
    const keyFail: UnlockLogEntry = { at: 40, method: 'securityKey', ok: false };
    expect(failedEntriesSinceLastSuccess([ok(1), fail(20), keyFail])).toEqual([fail(20), keyFail]);
  });

  it('is empty when the log ends on a success, and agrees with the count helper', () => {
    const cases: UnlockLogEntry[][] = [[ok(1), ok(2)], [], [fail(1), fail(2)], [ok(1), fail(2), fail(3)]];
    for (const log of cases) {
      expect(failedEntriesSinceLastSuccess(log).length).toBe(failedSinceLastSuccess(log));
    }
    expect(failedEntriesSinceLastSuccess([ok(1), ok(2)])).toEqual([]);
  });
});

describe('previousSuccess', () => {
  it('returns the success before the most recent one (the last session)', () => {
    const log = [ok(100), fail(150), ok(200)];
    expect(previousSuccess(log)).toEqual(ok(100));
  });

  it('is null on the first-ever unlock', () => {
    expect(previousSuccess([ok(100)])).toBeNull();
    expect(previousSuccess([fail(50), ok(100)])).toBeNull();
  });
});
