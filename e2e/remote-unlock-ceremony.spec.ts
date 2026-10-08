// Remote unlock, end to end, on the production build with two devices on the
// fake GitHub (reliability review 2026-10-08):
// - the request prompt is a top-layer dialog: it shows, answerable, over the
//   trusted device's open Settings (a plain overlay sat hidden under it);
// - after a Deny, the next request from that device is held back as a line with
//   "Show request" — not dropped while the locked device waits on its code.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, appShell, closeSettings, configureSync, createList, enableParanoid, lock, lockHeading, openApp, openSettings,
} from './helpers';

async function nameDevice(page: Page, name: string): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  const field = dialog.getByLabel("This device's name");
  await field.fill(name);
  await field.locator('xpath=ancestor::div[contains(@class,"items-end")][1]').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Device name saved|Saved \(will publish on next sync\)/).first()).toBeVisible();
  await closeSettings(page);
}

const prompt = (page: Page) => page.getByRole('dialog', { name: 'Remote unlock requested' });

async function requestUnlock(laptop: Page): Promise<string> {
  await laptop.getByRole('button', { name: /Request unlock from a trusted device/ }).click();
  const code = laptop.locator('p.tracking-\\[0\\.3em\\]');
  await expect(code).toHaveText(/^\d{2}-\d{2}$/, { timeout: 30_000 });
  return (await code.innerText()).trim();
}

test('a request shows over the trusted device\'s open Settings, and a declined device\'s next request is held, not lost', async ({ page: laptop, browser, github }) => {
  test.setTimeout(420_000);

  // The phone: sync on, Paranoid Mode off.
  const phoneContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(phoneContext);
  const phone = await phoneContext.newPage();
  await openApp(phone);
  await createList(phone, 'Errands'); // so its first sync writes a snapshot (and the salt)
  await configureSync(phone, github);
  await closeSettings(phone);
  await expect.poll(() => github.readText('gtd25-snapshot.json'), { timeout: 60_000 }).toBeTruthy();
  await nameDevice(phone, 'My Phone');
  await expect.poll(() => github.readText('gtd25-devices.json'), { timeout: 60_000 }).toContain('My Phone');

  // The laptop: sync on, Paranoid Mode on, trusts the phone.
  await openApp(laptop);
  await configureSync(laptop, github);
  await closeSettings(laptop);
  await nameDevice(laptop, 'Work Laptop');
  await enableParanoid(laptop, MAIN_PASSPHRASE);
  const security = await openSettings(laptop, 'Security');
  await security.getByRole('button', { name: 'Set up remote unlock' }).click();
  await security.getByRole('checkbox', { name: /My Phone/ }).check();
  await security.getByRole('button', { name: 'Enable for selected' }).click();
  await laptop.getByPlaceholder('Vault passphrase').fill(MAIN_PASSPHRASE);
  await laptop.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(laptop.getByText('Remote unlock enabled').first()).toBeVisible({ timeout: 60_000 });
  await closeSettings(laptop);

  // The phone takes the invitation — and stays in its Settings.
  const phoneSecurity = await openSettings(phone, 'Security');
  await phoneSecurity.getByRole('button', { name: 'Check for new invitations' }).click();
  await expect(phoneSecurity.locator('li').filter({ hasText: 'Work Laptop' })).toBeVisible({ timeout: 30_000 });

  // 1. Locked laptop asks; the prompt comes up over the phone's open Settings, and is answerable there.
  await lock(laptop);
  const code = await requestUnlock(laptop);
  await expect(prompt(phone)).toBeVisible({ timeout: 45_000 });
  await expect(prompt(phone)).toContainText(code);
  await expect(phoneSecurity).toBeVisible(); // Settings was not closed under it
  await prompt(phone).getByRole('button', { name: 'Approve unlock' }).click({ timeout: 10_000 });
  await expect(appShell(laptop)).toBeVisible({ timeout: 30_000 });
  await expect(prompt(phone)).toHaveCount(0);
  await closeSettings(phone);

  // 2. Asked again and denied: the next request is held back as a line, not dropped.
  await lock(laptop);
  await requestUnlock(laptop);
  await expect(prompt(phone)).toBeVisible({ timeout: 45_000 });
  await prompt(phone).getByRole('button', { name: 'Deny' }).click();
  await laptop.getByRole('button', { name: 'Cancel request' }).click();
  const second = await requestUnlock(laptop);
  const held = phone.getByRole('status').filter({ hasText: 'Held back: you declined a request from it' });
  await expect(held).toBeVisible({ timeout: 45_000 });
  await expect(prompt(phone)).toHaveCount(0);
  await held.getByRole('button', { name: 'Show request' }).click();
  await expect(prompt(phone)).toContainText(second);
  await prompt(phone).getByRole('button', { name: 'Approve unlock' }).click({ timeout: 10_000 });
  await expect(appShell(laptop)).toBeVisible({ timeout: 30_000 });
  await expect(lockHeading(laptop)).toHaveCount(0);
  await phoneContext.close();
});
