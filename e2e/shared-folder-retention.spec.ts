// The Shared Folder lists the newest item first, each card with when it was
// added; everything is deleted 30 days after it was added, its card fading into
// the page over the last 10. Real UI on the production build; Playwright's
// clock moves the wall clock, and runFor runs the minute tick.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp } from './helpers';

const DAY = 24 * 60 * 60_000;

async function pasteLink(page: Page, url: string): Promise<void> {
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, url);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
}

const cards = (page: Page) => page.locator('[data-redact]').filter({ hasText: /example\.com/ });
const opacity = (page: Page, host: string) =>
  cards(page).filter({ hasText: host }).evaluate((el) => Number(getComputedStyle(el).opacity));

test('newest first with the time added; fading in the last 10 days, gone at 30', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();

  await pasteLink(page, 'https://first.example.com/');
  await expect(cards(page)).toHaveCount(1);
  await page.clock.runFor(60_000);
  await pasteLink(page, 'https://second.example.com/');
  await expect(cards(page)).toHaveCount(2);

  await expect(cards(page).nth(0)).toContainText('second.example.com');
  await expect(cards(page).nth(1)).toContainText('first.example.com');
  for (const card of await cards(page).all()) {
    await expect(card.getByTitle(/^Added /)).toHaveText(/\d{1,2}:\d{2}/);
  }
  expect(await opacity(page, 'second.example.com')).toBe(1);

  // 25 days on: five left, the cards are fading.
  const start = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(start + 25 * DAY);
  await page.clock.runFor(60_000);
  await expect.poll(() => opacity(page, 'second.example.com')).toBeCloseTo(0.6, 1);
  await expect.poll(() => opacity(page, 'first.example.com')).toBeCloseTo(0.6, 1);

  // Past 30 days: both deleted.
  await page.clock.setSystemTime(start + 30 * DAY + 5 * 60_000);
  await page.clock.runFor(60_000);
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText('Nothing shared yet.')).toBeVisible();
});
