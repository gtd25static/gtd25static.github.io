// Re-keying a Paranoid device, end to end on the production build: every row
// and every wrap is rewritten under a fresh key behind the current passphrase,
// the content stays, the secondary passphrase has to be set again, and a
// passphrase change re-keys by default.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, SECONDARY_PASSPHRASE, ROTATED_PASSPHRASE,
  changePassphrase, closeSettings, createList, createTask, dumpDeviceStorage, enableParanoid, lock,
  openApp, openList, rekeyVault, setSecondaryPassphrase, taskCards, unlock, visibleText,
} from './helpers';

const LIST = 'LAYOFF_MEMO_Q3 board';
const TASKS = ['FIRE_THE_CFO before the board meeting', 'Send LAYOFF_MEMO_Q3 to legal'];

interface StoredRow { id: string; _enc?: string }
interface Stored {
  vault: Record<string, unknown>;
  tasks: StoredRow[];
  lists: StoredRow[];
  backups: string[];
}

/** The parts of the device's storage a re-key must rewrite, from a dumpDeviceStorage() string. */
function stored(dump: string): Stored {
  const parsed = JSON.parse(dump) as {
    indexedDb: { gtd25: Record<string, { values: unknown[] }> };
    localStorage: Record<string, string>;
  };
  const gtd25 = parsed.indexedDb.gtd25;
  return {
    vault: gtd25.vault.values[0] as Record<string, unknown>,
    tasks: gtd25.tasks.values as StoredRow[],
    lists: gtd25.taskLists.values as StoredRow[],
    backups: Object.keys(parsed.localStorage).filter((key) => key.startsWith('gtd25-local-backup-')),
  };
}

function encById(rows: StoredRow[]): Map<string, string | undefined> {
  return new Map(rows.map((row) => [row.id, row._enc]));
}

function expectRewritten(before: Stored, after: Stored): void {
  expect(after.tasks.length).toBe(before.tasks.length);
  for (const [id, enc] of encById(before.tasks)) {
    expect(enc, `task ${id} was encrypted before`).toBeTruthy();
    expect(encById(after.tasks).get(id), `task ${id} ciphertext changed`).not.toBe(enc);
  }
  for (const [id, enc] of encById(before.lists)) {
    expect(encById(after.lists).get(id), `list ${id} ciphertext changed`).not.toBe(enc);
  }
  for (const field of ['dekWrappedByPass', 'wrappedDek2', 'verifier', 'secrets', 'passSalt', 'prfSalt']) {
    expect(after.vault[field], `vault.${field} changed`).not.toBe(before.vault[field]);
  }
  expect(after.vault.securityKeys, 'no security key survives a re-key').toBeUndefined();
}

async function paranoidDevice(page: Page): Promise<void> {
  await openApp(page);
  await createList(page, LIST);
  for (const title of TASKS) await createTask(page, title);
  await enableParanoid(page, MAIN_PASSPHRASE);
}

async function expectRealContent(page: Page): Promise<void> {
  await closeSettings(page);
  await openList(page, 0);
  await expect(taskCards(page)).toHaveCount(TASKS.length);
  const text = await visibleText(page);
  for (const title of TASKS) expect(text).toContain(title);
}

test('re-keying rewrites every row and wrap, keeps the content, and re-randomises the secondary slot', async ({ page }) => {
  await paranoidDevice(page);
  await setSecondaryPassphrase(page, SECONDARY_PASSPHRASE);
  await closeSettings(page);
  const before = stored(await dumpDeviceStorage(page));

  await rekeyVault(page, MAIN_PASSPHRASE);

  const after = stored(await dumpDeviceStorage(page));
  expectRewritten(before, after);
  expect(after.backups, 'exactly one fresh safety backup').toHaveLength(1);
  for (const key of before.backups) expect(after.backups, 'no pre-re-key safety backup survives').not.toContain(key);
  await expectRealContent(page);

  await lock(page, 'button');
  expect(await unlock(page, SECONDARY_PASSPHRASE), 'the old secondary passphrase is gone').toBe(false);
  expect(await unlock(page, MAIN_PASSPHRASE), 'the main passphrase still opens the vault').toBe(true);
  await expectRealContent(page);
  await setSecondaryPassphrase(page, SECONDARY_PASSPHRASE); // can be set again
});

test('changing the passphrase re-keys by default and retires the old passphrase', async ({ page }) => {
  await paranoidDevice(page);
  await closeSettings(page);
  const before = stored(await dumpDeviceStorage(page));

  await changePassphrase(page, MAIN_PASSPHRASE, ROTATED_PASSPHRASE);

  expectRewritten(before, stored(await dumpDeviceStorage(page)));
  await lock(page, 'button');
  expect(await unlock(page, MAIN_PASSPHRASE), 'the old passphrase is dead').toBe(false);
  expect(await unlock(page, ROTATED_PASSPHRASE), 'the new passphrase opens the vault').toBe(true);
  await expectRealContent(page);
});

test('a re-key needs the current passphrase and changes nothing without it', async ({ page }) => {
  await paranoidDevice(page);
  await closeSettings(page);
  const before = await dumpDeviceStorage(page);

  await rekeyVault(page, ROTATED_PASSPHRASE, { expectIncorrect: true });

  expect(stored(await dumpDeviceStorage(page)).vault).toEqual(stored(before).vault);
  await expectRealContent(page);
});
