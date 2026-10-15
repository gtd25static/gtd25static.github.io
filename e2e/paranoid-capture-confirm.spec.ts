// Paranoid Mode: a captured page asks before it goes into the Inbox. Any page
// whose link you click can send a capture, and with the app window open and
// unlocked (launch_handler focus-existing) no unlock stands in between any
// more. Here the capture opens the app cold (a new, locked load): it asks after
// the unlock. Real UI on the production build.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { MAIN_PASSPHRASE, appShell, enableParanoid, openApp, unlock } from './helpers';

const captureUrl = (title: string) => `/?capture&title=${encodeURIComponent(title)}&url=${encodeURIComponent('https://example.com/a')}`;
const question = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Add to Inbox?' });

test('a capture asks "Add to Inbox?" after the unlock; Add files it, Discard does not', async ({ page }) => {
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);

  await page.goto(captureUrl('Wanted page'));
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await expect(question(page)).toBeVisible();
  await expect(question(page).getByText('Wanted page')).toBeVisible();
  // Nothing is focused on "Add": a stray Enter as the window appears files nothing.
  await expect(question(page).getByRole('button', { name: 'Add to Inbox' })).not.toBeFocused();
  await question(page).getByRole('button', { name: 'Add to Inbox' }).click();
  await expect(page.getByText('Captured to Inbox').first()).toBeVisible();

  await page.goto(captureUrl('Lure page'));
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await expect(question(page).getByText('Lure page')).toBeVisible();
  await page.keyboard.press('Escape'); // closing it discards
  await expect(question(page)).toHaveCount(0);

  await appShell(page).getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(appShell(page).getByRole('button', { name: 'Inbox 1', exact: true })).toBeVisible();
  await expect(page.getByText('Wanted page', { exact: true })).toBeVisible();
  await expect(page.getByText('Lure page')).toHaveCount(0);
});
