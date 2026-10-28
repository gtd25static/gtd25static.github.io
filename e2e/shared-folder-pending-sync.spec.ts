// A Shared Folder item not uploaded yet is marked "not synced yet"; the mark
// goes once a sync pushes it. Real UI on the production build against the fake
// GitHub: the link is added offline, so it has to wait.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, closeSettings, configureSync, openApp } from './helpers';

async function pasteLink(page: Page, url: string): Promise<void> {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, url);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
}

const card = (page: Page, host: string) => page.locator('[data-redact]').filter({ hasText: host });
const notSynced = (page: Page, host: string) => card(page, host).getByRole('img', { name: 'Not synced yet' });

test('a link added offline is marked until it is synced', async ({ page, context, github }) => {
  await openApp(page);
  await configureSync(page, github);
  await closeSettings(page);
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await pasteLink(page, 'https://waiting.example.com/');
  await expect(card(page, 'waiting.example.com')).toBeVisible();
  await expect(notSynced(page, 'waiting.example.com')).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(notSynced(page, 'waiting.example.com')).toHaveCount(0, { timeout: 60_000 });
  await expect(card(page, 'waiting.example.com')).toBeVisible();
});
