// Group F of the GUI review: mindmaps (Back into the folder, rename carrying
// over to the root, chatbot outlines, the node cap), the Shared Folder without
// sync, and the theme (an import applies it; a pick survives an OS change).
// Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, dialogTitled, openApp } from './helpers';

async function openMindmaps(page: Page): Promise<void> {
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await expect(page.getByRole('button', { name: 'New map', exact: true })).toBeVisible();
}

async function nameAndSubmit(page: Page, name: string, submit: 'Create' | 'Save'): Promise<void> {
  await page.getByPlaceholder('Name').fill(name);
  await page.getByRole('button', { name: submit, exact: true }).click();
}

const node = (page: Page, text: string): Locator => page.locator('[data-mindmap-node]').filter({ hasText: text });

async function openSettings(page: Page, tab: 'General' | 'Backups'): Promise<Locator> {
  await appShell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = dialogTitled(page, 'Settings');
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  return dialog;
}

const isDark = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.classList.contains('dark'));

test('Back from a map inside a folder returns to that folder', async ({ page }) => {
  await openApp(page);
  await openMindmaps(page);
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await nameAndSubmit(page, 'Work', 'Create');
  await page.getByText('Work', { exact: true }).click();
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await nameAndSubmit(page, 'Plan', 'Create');
  await expect(node(page, 'Plan')).toBeVisible();

  await page.getByRole('button', { name: 'Back to mindmaps' }).click();
  await expect(page.getByRole('navigation', { name: 'Folder path' }).getByText('Work')).toBeVisible();
  await expect(page.getByText('Plan', { exact: true })).toBeVisible();
});

test('renaming a map renames its root node', async ({ page }) => {
  await openApp(page);
  await openMindmaps(page);
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await nameAndSubmit(page, 'Plan', 'Create');
  await expect(node(page, 'Plan')).toBeVisible();
  await page.getByRole('button', { name: 'Back to mindmaps' }).click();

  const row = page.locator('div.group').filter({ has: page.getByText('Plan', { exact: true }) });
  await row.locator('[data-dropdown-trigger]').click();
  await page.locator('[data-dropdown-menu]').getByRole('button', { name: 'Rename', exact: true }).click();
  await nameAndSubmit(page, 'Launch plan', 'Save');
  await page.getByText('Launch plan', { exact: true }).click();
  await expect(node(page, 'Launch plan')).toBeVisible();
});

test('a chatbot outline imports cleanly, and the node cap counts the root', async ({ page }) => {
  await openApp(page);
  await openMindmaps(page);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const outline = page.getByPlaceholder(/# My map/);
  await outline.fill([
    'Sure! Here is the outline:',
    '',
    '```markdown',
    '# Sleep',
    '**Stages**',
    '1. Deep sleep',
    '   a. Clears the brain',
    '   b. Restores the body',
    '2. REM',
    '',
    '**Habits**',
    '• Same bedtime',
    '• No screens',
    '```',
    '',
    'Let me know if you want more detail on any point.',
  ].join('\n'));
  // Sleep, Stages, Deep sleep, 2 sub-points, REM, Habits, 2 habits
  await expect(page.getByText(/· 9 node\(s\)/)).toBeVisible();
  await expect(page.getByText('Text after the outline was left out.')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();

  for (const label of ['Sleep', 'Stages', 'Deep sleep', 'Clears the brain', 'Restores the body', 'REM', 'Habits', 'Same bedtime', 'No screens']) {
    await expect(node(page, label).first(), label).toBeVisible();
  }
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(9);
  await expect(page.locator('[data-mindmap-node]').filter({ hasText: /Let me know|```|•/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to mindmaps' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByPlaceholder(/# My map/).fill(['# Big', ...Array.from({ length: 2000 }, (_, i) => `- n${i}`)].join('\n'));
  await expect(page.getByRole('alert')).toHaveText(/more than 2000 nodes/);
  await expect(page.getByRole('button', { name: 'Import', exact: true }).last()).toBeDisabled();
});

test('the Shared Folder says a text snippet needs sync instead of "try again"', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'A note to keep');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText(/set up sync in Settings/)).toBeVisible();
  await expect(page.getByText(/Please try again/)).toHaveCount(0);
});

test('an imported backup\'s theme applies at once, and a picked theme survives an OS change', async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, 'General');
  await settings.getByRole('button', { name: 'Dark', exact: true }).click();
  expect(await isDark(page)).toBe(true);

  // App's own copy of the theme used to stay on "System" and re-apply the OS
  // scheme over the pick when it changed.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await isDark(page)).toBe(true);

  await settings.getByRole('button', { name: 'Backups', exact: true }).click();
  await settings.getByRole('button', { name: 'Export Backup', exact: true }).click();
  const exportDialog = dialogTitled(page, 'Export backup');
  await exportDialog.getByText('Unencrypted', { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const zipPath = test.info().outputPath('backup.zip');
  await download.saveAs(zipPath);

  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await settings.getByRole('button', { name: 'Light', exact: true }).click();
  expect(await isDark(page)).toBe(false);

  await settings.getByRole('button', { name: 'Backups', exact: true }).click();
  await settings.locator('input[type="file"][accept=".zip"]').setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Import', exact: true }).last().click(); // confirm
  await expect(page.getByText('Backup imported successfully')).toBeVisible();
  await expect.poll(() => isDark(page)).toBe(true);
});
