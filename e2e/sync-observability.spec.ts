// Group C of the GUI review: what the sync indicator says, and a task added to a
// list another device was deleting at the same time. Two devices on the fake
// GitHub, production build.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import type { FakeGitHub } from './fake-github';
import { appShell, closeSettings, configureSync, createList, createTask, openApp, openList, openSettings, taskCards } from './helpers';

const indicator = (page: Page) => appShell(page).locator('div.ml-auto > button').first();

async function syncNowVia(page: Page): Promise<void> {
  const dialog = await openSettings(page, 'General');
  await dialog.getByRole('button', { name: 'Sync Now', exact: true }).click();
  await expect(page.getByText(/Sync complete|Initial sync complete|Synced from remote/).first()).toBeVisible({ timeout: 60_000 });
  await closeSettings(page);
}

async function secondDevice(browser: Browser, github: FakeGitHub): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(context);
  const page = await context.newPage();
  await openApp(page);
  await configureSync(page, github);
  await closeSettings(page);
  return { context, page };
}

test('offline with changes waiting, the indicator says so', async ({ page, context, github }) => {
  await openApp(page);
  await createList(page, 'Offline list');
  await configureSync(page, github);
  await closeSettings(page);
  await expect(indicator(page)).toContainText(/Synced|↑/, { timeout: 60_000 });

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await createTask(page, 'Made while offline');
  await expect(indicator(page)).toHaveText('Offline — changes waiting to sync', { timeout: 20_000 });
});

test('a task added to a list another device was deleting ends up in the Trash with it, and comes back with it', async ({ page, browser, github }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await createList(page, 'Shared plans');
  await configureSync(page, github);
  await closeSettings(page);
  const other = await secondDevice(browser, github);
  await expect(appShell(other.page).getByText('Shared plans')).toBeVisible({ timeout: 60_000 });

  // A deletes the list and syncs; B, not yet synced, adds a task to it.
  const row = appShell(page).locator('nav [data-focus-id]').filter({ hasText: 'Shared plans' });
  await row.hover();
  await row.getByRole('button').last().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click(); // confirm
  await syncNowVia(page);
  await openList(other.page, 'Shared plans');
  await createTask(other.page, 'Added meanwhile');
  await syncNowVia(other.page);
  await syncNowVia(page);

  // Next start on B: the task goes to the Trash with its list...
  await other.page.reload();
  await expect(appShell(other.page)).toBeVisible();
  await expect(appShell(other.page).getByText('Shared plans')).toHaveCount(0);
  await appShell(other.page).getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = other.page.getByRole('dialog').filter({ hasText: 'Trash' });
  await expect(trash.getByText('Added meanwhile')).toBeVisible();
  // ...and restoring the list brings it back.
  await trash.locator('li, div').filter({ hasText: /^.*Shared plans/ }).getByRole('button', { name: 'Restore' }).first().click();
  await trash.getByRole('button', { name: 'Close', exact: true }).click();
  await openList(other.page, 'Shared plans');
  await expect(taskCards(other.page).filter({ hasText: 'Added meanwhile' })).toBeVisible();
  await other.context.close();
});

test('changes that arrive through the snapshot count in "↓"', async ({ page, browser, github }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await createList(page, 'Batch');
  await configureSync(page, github);
  await closeSettings(page);
  const other = await secondDevice(browser, github);
  await expect(appShell(other.page).getByText('Batch')).toBeVisible({ timeout: 60_000 });

  // 31 changes on A: its sync compacts them into the snapshot and empties the changelog.
  await openList(page, 'Batch');
  for (let i = 0; i < 31; i++) await createTask(page, `Batch task ${i}`);
  await syncNowVia(page);
  await expect.poll(() => github.readText('gtd25-changelog.json'), { timeout: 60_000 }).toBe('[]');

  await syncNowVia(other.page);
  await expect(indicator(other.page)).toContainText(/↓\s?3[12]/, { timeout: 30_000 });
  await other.context.close();
});
