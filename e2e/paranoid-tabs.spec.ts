// Paranoid Mode with the app open in more than one tab, on the production build.
//
// Turning it off in one tab used to leave an unlocked second tab encrypting what
// it wrote under a key the disable had just destroyed — rows nobody could read
// again, and a list holding one crashed the app on the next load. Turning it on
// crashed an open second tab, which read the rows back as ciphertext. And a
// panic wipe whose deletion was blocked left the next boot unable to save.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, appShell, closeSettings, confirmPassphrasePrompt, createList, createTask, enableParanoid,
  lockHeading, openApp, openList, openSettings, taskCards, unlock, visibleText,
} from './helpers';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __e2eMarked?: boolean }).__e2eMarked = true; });
}
async function wasReloaded(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => !(window as unknown as { __e2eMarked?: boolean }).__e2eMarked);
  } catch {
    return false; // mid-navigation: ask again
  }
}

/** Ids of rows still carrying at-rest ciphertext, straight from IndexedDB. */
async function encryptedRows(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const settle = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const out: string[] = [];
      for (const store of ['taskLists', 'tasks', 'subtasks', 'changeLog']) {
        const rows = await settle(db.transaction(store, 'readonly').objectStore(store).getAll()) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const enc = store === 'changeLog' ? (row.data as Record<string, unknown> | undefined)?._enc : row._enc;
          if (enc !== undefined) out.push(`${store}:${String(row.id)}`);
        }
      }
      return out;
    } finally {
      db.close();
    }
  });
}

const crashed = (page: Page) => page.getByText('Something went wrong').isVisible();

test('turning Paranoid Mode off locks and reloads an unlocked second tab, which then writes nothing unreadable', async ({ page, context }) => {
  await openApp(page);
  await createList(page, 'Tabs list');
  await createTask(page, 'First task');
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  const tab2 = await context.newPage();
  await tab2.goto('/');
  expect(await unlock(tab2, MAIN_PASSPHRASE)).toBe(true);
  await closeSettings(tab2);
  await openList(tab2, 'Tabs list');
  await markDocument(tab2);

  await page.bringToFront();
  const dialog = await openSettings(page, 'Security');
  await dialog.getByRole('button', { name: 'Disable Paranoid Mode' }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await confirmPassphrasePrompt(page);
  await expect(page.getByText('Paranoid Mode disabled').first()).toBeVisible({ timeout: 90_000 });

  await expect.poll(() => wasReloaded(tab2), { message: 'tab 2 reloads after the disable', timeout: 15_000 }).toBe(true);
  await expect(appShell(tab2), 'tab 2 comes back as an ordinary app').toBeVisible();
  await tab2.bringToFront();
  await openList(tab2, 'Tabs list');
  await createTask(tab2, 'Written in tab 2 afterwards');
  expect(await encryptedRows(page), 'rows left encrypted with no vault to open them').toEqual([]);

  await page.bringToFront();
  await page.reload();
  await expect(appShell(page)).toBeVisible();
  await closeSettings(page);
  await openList(page, 'Tabs list');
  const text = await visibleText(page);
  expect(text).toContain('First task');
  expect(text).toContain('Written in tab 2 afterwards');
  expect(await crashed(page)).toBe(false);
});

test('turning Paranoid Mode on reloads an open second tab into the lock screen instead of crashing it', async ({ page, context }) => {
  await openApp(page);
  await createList(page, 'Tabs list');
  await createTask(page, 'First task');
  const tab2 = await context.newPage();
  await tab2.goto('/');
  await expect(appShell(tab2)).toBeVisible();
  await openList(tab2, 'Tabs list');
  await markDocument(tab2);

  await page.bringToFront();
  await enableParanoid(page, MAIN_PASSPHRASE);

  await expect.poll(() => wasReloaded(tab2), { message: 'tab 2 reloads after the enable', timeout: 15_000 }).toBe(true);
  await expect(lockHeading(tab2), 'tab 2 comes back locked').toBeVisible();
  expect(await crashed(tab2)).toBe(false);
  await tab2.bringToFront();
  expect(await unlock(tab2, MAIN_PASSPHRASE)).toBe(true);
  await closeSettings(tab2);
  await openList(tab2, 'Tabs list');
  await expect(taskCards(tab2).filter({ hasText: 'First task' })).toBeVisible();
});

test('a panic wipe whose deletion is blocked is finished at the next boot, and the app can save right after', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eWipePendingAtBoot: string | null }).__e2eWipePendingAtBoot = localStorage.getItem('gtd25-wipe-pending');
  });
  await openApp(page);
  await createList(page, 'Before the wipe');
  await enableParanoid(page, MAIN_PASSPHRASE);
  // A connection that ignores versionchange — what a busy transaction or another tab amounts to — blocks the deletion.
  await page.evaluate(async () => {
    const request = indexedDB.open('gtd25');
    const held = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    (window as unknown as { __e2eHeld: IDBDatabase }).__e2eHeld = held;
  });
  const dialog = await openSettings(page, 'Security');
  await dialog.getByRole('button', { name: 'Panic wipe' }).click();
  await page.getByRole('button', { name: 'Wipe this device' }).click();

  await expect(appShell(page)).toBeVisible({ timeout: 60_000 });
  const pendingAtBoot = await page.evaluate(() => (window as unknown as { __e2eWipePendingAtBoot: string | null }).__e2eWipePendingAtBoot);
  expect(pendingAtBoot, 'the deletion was blocked, so the boot retried it').not.toBeNull();
  expect(await page.getByText('Before the wipe').count()).toBe(0);
  await createList(page, 'After the wipe'); // failed with DatabaseClosedError until a second reload
  await page.reload();
  await expect(appShell(page).getByText('After the wipe')).toBeVisible();
});
