// Paranoid Mode enable/disable interrupted by the tab dying, on the production
// build. The flag (localStorage) and the vault (IndexedDB) can't be written
// atomically; whatever point the tab dies at, the device must come back either
// fully un-Paranoid with its data or at the lock screen with its data — never
// looking un-Paranoid over rows it can't read (which is what an enable killed
// mid-encryption used to leave, and a second enable then destroyed for good).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, appShell, closeSettings, dumpDeviceStorage, enableParanoid, findMarkers,
  lockHeading, openApp, openList, openSettings, taskCards, unlock,
} from './helpers';

const LIST = 'Seeded list';
const COUNT = 1500;
const MARKER = 'CRASH_MARKER';

/** Put COUNT tasks straight into IndexedDB, so the enable has real work to be interrupted in. */
async function seedManyTasks(page: Page): Promise<void> {
  await page.evaluate(async ({ list, count, marker }) => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const tx = db.transaction(['taskLists', 'tasks'], 'readwrite');
      const now = Date.now();
      tx.objectStore('taskLists').put({ id: 'seed-list', name: list, type: 'tasks', order: 0, createdAt: now, updatedAt: now });
      for (let i = 0; i < count; i++) {
        tx.objectStore('tasks').put({
          id: `seed-${String(i).padStart(5, '0')}`, listId: 'seed-list', title: `${marker} ${i}`,
          description: `${marker} notes ${i}`, status: 'todo', order: i, createdAt: now, updatedAt: now,
        });
      }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    } finally {
      db.close();
    }
  }, { list: LIST, count: COUNT, marker: MARKER });
}

// Opening a list of COUNT tasks renders every card at once: ~8-11 s without
// Paranoid Mode and ~15-19 s with it on this machine — right at the helper's
// generic 20 s, so any CPU pressure from the rest of the suite failed these
// recovery tests on timing alone. They check that the vault comes back intact,
// not how fast a huge list renders (that's a performance item of its own).
const BIG_LIST_OPEN_MS = 60_000;

async function vaultState(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const vault = await settle(db.transaction('vault', 'readonly').objectStore('vault').get('vault')) as { migrationState?: string } | undefined;
      return vault?.migrationState ?? null;
    } finally {
      db.close();
    }
  });
}

test('an enable killed mid-encryption comes back at the lock screen and finishes on unlock', async ({ page, context }) => {
  await openApp(page);
  await seedManyTasks(page);
  await page.reload();
  await expect(appShell(page)).toBeVisible();

  const dialog = await openSettings(page, 'Security');
  await dialog.getByLabel('Passphrase', { exact: true }).fill(MAIN_PASSPHRASE);
  await dialog.getByLabel('Confirm passphrase', { exact: true }).fill(MAIN_PASSPHRASE);
  await dialog.getByRole('button', { name: 'Enable Paranoid Mode' }).click();
  // The flag goes up right before the first row is rewritten: kill the tab then.
  await page.waitForFunction(() => localStorage.getItem('gtd25-paranoid') === '1', null, { polling: 5, timeout: 90_000 });
  await page.close({ runBeforeUnload: false });

  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(lockHeading(reopened), 'back at the lock screen, not an un-Paranoid app').toBeVisible();
  expect(await vaultState(reopened), 'the tab really died mid-encryption').toBe('encrypting');

  expect(await unlock(reopened, MAIN_PASSPHRASE), 'the passphrase chosen for the interrupted enable unlocks').toBe(true);
  await expect.poll(() => vaultState(reopened), { timeout: 60_000 }).toBe('done');
  await closeSettings(reopened);
  await openList(reopened, LIST, { timeout: BIG_LIST_OPEN_MS });
  await expect(taskCards(reopened).filter({ hasText: `${MARKER} 0` }).first()).toBeVisible();
  await expect(taskCards(reopened).filter({ hasText: `${MARKER} ${COUNT - 1}` }).first()).toBeVisible();
  await expect(taskCards(reopened)).toHaveCount(COUNT);
  expect(findMarkers(await dumpDeviceStorage(reopened), [MARKER]), 'nothing left in plaintext on disk').toEqual([]);
});

test('a vault saved just before the tab died (flag never written) still comes back locked', async ({ page }) => {
  await openApp(page);
  await seedManyTasks(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await page.evaluate(() => localStorage.removeItem('gtd25-paranoid'));

  await page.reload();
  await expect(lockHeading(page)).toBeVisible();
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await closeSettings(page);
  await openList(page, LIST, { timeout: BIG_LIST_OPEN_MS });
  await expect(taskCards(page).filter({ hasText: `${MARKER} 7` }).first()).toBeVisible();
});

test('a flag left behind by a disable that already deleted the vault does not strand the app at the lock screen', async ({ page }) => {
  await openApp(page);
  await seedManyTasks(page);
  await page.evaluate(() => localStorage.setItem('gtd25-paranoid', '1'));

  await page.reload();
  await expect(appShell(page)).toBeVisible();
  await expect(lockHeading(page)).toBeHidden();
  await openList(page, LIST, { timeout: BIG_LIST_OPEN_MS });
  await expect(taskCards(page).filter({ hasText: `${MARKER} 7` }).first()).toBeVisible();
});
