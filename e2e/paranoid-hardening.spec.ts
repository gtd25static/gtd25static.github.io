// Group B of the GUI review: on a Paranoid device, an unlocked but unattended
// session must not be able to loosen protection or move sync elsewhere without
// the passphrase; tightening never asks. Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, SYNC_PASSWORD, closeSettings, configureSync, enableParanoid, lock, openApp, openSettings, unlock,
} from './helpers';

const passphrasePrompt = (page: Page) => page.getByPlaceholder('Vault passphrase');

async function answerPrompt(page: Page, passphrase: string | null): Promise<void> {
  await expect(passphrasePrompt(page)).toBeVisible();
  if (passphrase === null) {
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  } else {
    await passphrasePrompt(page).fill(passphrase);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await expect(passphrasePrompt(page)).toBeHidden();
}

const toggle = (dialog: Locator, name: RegExp) => dialog.getByRole('checkbox', { name });

test('switching a protection on is free; switching it off needs the passphrase', async ({ page }) => {
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  const dialog = await openSettings(page, 'Security');
  const hotkey = toggle(dialog, /Instant-lock hotkey/);

  await hotkey.click(); // on: tightening
  await expect(hotkey).toBeChecked();
  await expect(passphrasePrompt(page)).toBeHidden();

  await hotkey.click(); // off: asks
  await answerPrompt(page, null);
  await expect(hotkey).toBeChecked();

  await hotkey.click();
  await answerPrompt(page, 'not the passphrase at all 42');
  await expect(page.getByText('Incorrect passphrase').first()).toBeVisible();
  await expect(hotkey).toBeChecked();

  await hotkey.click();
  await answerPrompt(page, MAIN_PASSPHRASE);
  await expect(hotkey).not.toBeChecked();
});

test('a longer auto-lock needs the passphrase, a shorter one does not', async ({ page }) => {
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  const dialog = await openSettings(page, 'Security');
  const idle = dialog.getByLabel('Auto-lock after (minutes idle)');
  const save = idle.locator('xpath=ancestor::div[contains(@class,"items-end")][1]').getByRole('button', { name: 'Save' });

  await idle.fill('5');
  await save.click();
  await expect(page.getByText('Auto-lock updated').first()).toBeVisible();
  await expect(passphrasePrompt(page)).toBeHidden();

  await idle.fill('120');
  await save.click();
  await answerPrompt(page, null);
  await expect(idle).toHaveValue('5');

  await idle.fill('120');
  await save.click();
  await answerPrompt(page, MAIN_PASSPHRASE);
  await expect(idle).toHaveValue('120');
});

test('clearing the unlock log needs the passphrase', async ({ page }) => {
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  let dialog = await openSettings(page, 'Security');
  await toggle(dialog, /Unlock audit trail/).click();
  await closeSettings(page);
  await lock(page);
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);

  dialog = await openSettings(page, 'Security');
  const clear = dialog.getByRole('button', { name: 'Clear log', exact: true });
  await clear.click();
  await answerPrompt(page, null);
  await expect(clear).toBeVisible(); // still there: nothing cleared

  await clear.click();
  await answerPrompt(page, MAIN_PASSPHRASE);
  await expect(page.getByText('Unlock log cleared').first()).toBeVisible();
  await expect(clear).toBeHidden();
});

test('pointing a Paranoid device at a repository needs the passphrase', async ({ page, github }) => {
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  // Without it the helper fails on the question; with it the link goes through.
  await expect(configureSync(page, github, SYNC_PASSWORD)).rejects.toThrow(/asked for the vault passphrase/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await configureSync(page, github, SYNC_PASSWORD, { vaultPassphrase: MAIN_PASSPHRASE });
});
