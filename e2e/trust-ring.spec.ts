// Group K: the duress wipe sends no signal (user's choice, "option 1"); the
// trust ring infers from silence. A protected device refreshes its registry
// entry while unlocked, and its trusted devices show when it was last seen.
// Two devices on the fake GitHub, production build.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { MAIN_PASSPHRASE, closeSettings, configureSync, createList, enableParanoid, openApp, openSettings } from './helpers';

async function nameDevice(page: Page, name: string): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  const field = dialog.getByLabel("This device's name");
  await field.fill(name);
  await field.locator('xpath=ancestor::div[contains(@class,"items-end")][1]').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Device name saved|Saved \(will publish on next sync\)/).first()).toBeVisible();
  await closeSettings(page);
}

test('a trusted device shows when the protected device was last seen', async ({ page, browser, github }) => {
  test.setTimeout(300_000);

  // The phone: sync on, Paranoid Mode off.
  const phoneContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(phoneContext);
  const phone = await phoneContext.newPage();
  await openApp(phone);
  await createList(phone, 'Errands'); // so its first sync writes a snapshot
  await configureSync(phone, github);
  await closeSettings(phone);
  // That snapshot carries the sync salt the laptop joins (the registry's MAC key
  // derives from it); an empty device writes none, and the salt is born later.
  await expect.poll(() => github.readText('gtd25-snapshot.json'), { timeout: 60_000 }).toBeTruthy();
  await nameDevice(phone, 'My Phone');
  await expect.poll(() => github.readText('gtd25-devices.json'), { timeout: 60_000 }).toContain('My Phone');

  // The laptop: sync on, Paranoid Mode on, trusts the phone.
  await openApp(page);
  await configureSync(page, github);
  await closeSettings(page);
  await nameDevice(page, 'Work Laptop');
  await enableParanoid(page, MAIN_PASSPHRASE);
  const security = await openSettings(page, 'Security');
  await security.getByRole('button', { name: 'Set up remote unlock' }).click();
  await security.getByRole('checkbox', { name: /My Phone/ }).check();
  await security.getByRole('button', { name: 'Enable for selected' }).click();
  await page.getByPlaceholder('Vault passphrase').fill(MAIN_PASSPHRASE);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Remote unlock enabled').first()).toBeVisible({ timeout: 60_000 });

  // The phone picks up the invitation and shows the laptop as seen just now.
  const phoneSecurity = await openSettings(phone, 'Security');
  await phoneSecurity.getByRole('button', { name: 'Check for new invitations' }).click();
  const row = phoneSecurity.locator('li').filter({ hasText: 'Work Laptop' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await phoneSecurity.getByRole('button', { name: 'Refresh wipe status' }).click();
  await expect(row.locator('[data-device-activity]')).toHaveText(/^Last seen (just now|\d+m ago)$/, { timeout: 60_000 });
  await phoneContext.close();
});
