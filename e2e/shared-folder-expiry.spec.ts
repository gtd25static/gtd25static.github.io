// What a device in Paranoid Mode adds to the Shared Folder is deleted 24 h
// later, and its card says so; what was added before Paranoid stays. A night
// asleep is the usual way past the 24 h: the vault idle-locks, and the expired
// item goes as soon as the vault is opened again. Real UI on the production
// build; Playwright's clock moves the wall clock without running timers.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { MAIN_PASSPHRASE, appShell, closeSettings, enableParanoid, lockHeading, openApp, unlock } from './helpers';

const HOUR = 60 * 60_000;

async function openSharedFolder(page: Page): Promise<void> {
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();
}

async function pasteLink(page: Page, url: string): Promise<void> {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, url);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
}

const card = (page: Page, host: string) => page.locator('[data-redact]').filter({ hasText: host });

test('a link added in Paranoid Mode counts down and is gone after 24 h; one added before stays', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await openSharedFolder(page);
  await pasteLink(page, 'https://before.example.com/kept');
  await expect(card(page, 'before.example.com')).toBeVisible();
  await expect(card(page, 'before.example.com').getByText(/Deletes in/)).toHaveCount(0);

  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  await openSharedFolder(page);
  await pasteLink(page, 'https://during.example.com/goes');
  await expect(card(page, 'during.example.com').getByText('Deletes in 24h')).toBeVisible();

  // A night asleep: the wall clock moves 25 h, no timer runs. The vault locks.
  const now = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(now + 25 * HOUR);
  await expect(lockHeading(page)).toBeVisible({ timeout: 10_000 });

  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await openSharedFolder(page);
  await expect(card(page, 'before.example.com')).toBeVisible();
  await expect(card(page, 'during.example.com')).toHaveCount(0);
});

test('a few hours in, the card shows the hours left', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  await openSharedFolder(page);
  await pasteLink(page, 'https://countdown.example.com/');
  await expect(card(page, 'countdown.example.com').getByText('Deletes in 24h')).toBeVisible();

  // Ten minutes on (inside the idle window), with the minute tick run.
  await page.clock.runFor(10 * 60_000);
  await expect(card(page, 'countdown.example.com').getByText('Deletes in 23h')).toBeVisible();
});
