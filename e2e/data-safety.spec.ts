// Group A of the GUI review: things that could lose data or order without saying
// so. Drives the real UI on the production build (dnd-kit drags, native dialogs,
// downloads), which unit tests can't.
import JSZip from 'jszip';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createList, createTask, openApp, taskCards, appShell, dialogTitled } from './helpers';

const sidebarList = (page: Page, name: string): Locator =>
  page.locator('aside nav [data-focus-id]').filter({ hasText: name });

/** The ⋮ menu next to the open list's heading. */
async function listMenu(page: Page, item: RegExp): Promise<void> {
  await page.getByRole('heading', { level: 2 }).locator('..').getByRole('button').first().click();
  await page.getByRole('button', { name: item }).click();
}

async function titlesInOrder(page: Page): Promise<string[]> {
  return (await taskCards(page).locator('[title="Double-click to edit"]').allTextContents()).map((t) => t.trim());
}

async function dragOnto(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 20 });
  await page.mouse.up();
}

async function openSettingsTab(page: Page, tab: string): Promise<Locator> {
  await appShell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = dialogTitled(page, 'Settings');
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  return dialog;
}

test('dragging while sorted by name refuses to rewrite the manual order', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Errands');
  for (const title of ['Bravo', 'Alpha', 'Charlie']) await createTask(page, title);
  const manual = await titlesInOrder(page);

  await listMenu(page, /^Sort by name/);
  await expect.poll(() => titlesInOrder(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  const charlie = taskCards(page).filter({ hasText: 'Charlie' });
  await dragOnto(page, charlie.locator('.cursor-grab').first(), taskCards(page).filter({ hasText: 'Alpha' }));
  await expect(page.getByText(/Turn off .Sort by name\/date. to rearrange/)).toBeVisible();

  await listMenu(page, /^Sort by name/); // back to manual
  await expect.poll(() => titlesInOrder(page)).toEqual(manual);
});

test('unchecking a subtask reopens the parent its subtasks completed', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Project');
  await createTask(page, 'Parent task');
  const parent = taskCards(page).filter({ hasText: 'Parent task' });
  await parent.getByText('Parent task').click(); // expand
  for (const title of ['First step', 'Second step']) {
    await parent.getByRole('button', { name: 'Add subtask' }).click();
    await page.getByPlaceholder('Subtask title').fill(title);
    await page.getByPlaceholder('Subtask title').press('Enter');
    await expect(parent.getByText(title)).toBeVisible();
  }
  // Subtask boxes are titled, the parent's box is aria-labelled.
  const parentBox = (state: string) => parent.locator(`button[aria-label="${state}"]`);
  for (let done = 1; done <= 2; done++) {
    await parent.locator('button[title="Mark complete"]').first().click();
    await expect(parent.locator('button[title="Mark incomplete"]')).toHaveCount(done); // settled before the next click
  }
  await expect(parentBox('Mark incomplete')).toBeVisible();

  await parent.locator('button[title="Mark incomplete"]').first().click();
  await expect(parentBox('Mark complete')).toBeVisible();
});

test('"Inbox" is reserved, and a double click on Create makes one list', async ({ page }) => {
  await openApp(page);
  const lists = page.locator('aside nav [data-focus-id]');
  const before = await lists.count();

  await page.getByRole('button', { name: 'Create new list' }).click();
  await page.getByPlaceholder('List name').fill('inbox');
  await page.getByPlaceholder('List name').press('Enter');
  await expect(page.getByText(/“Inbox” is reserved/)).toBeVisible();
  await expect(lists).toHaveCount(before);

  await page.getByPlaceholder('List name').fill('Once');
  await page.getByRole('button', { name: 'Create', exact: true }).dblclick();
  await expect(page.getByRole('heading', { level: 2, name: 'Once', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(sidebarList(page, 'Once')).toHaveCount(1);
});

test('Wipe All Data says it erases mindmaps and the Shared Folder', async ({ page }) => {
  await openApp(page);
  const settings = await openSettingsTab(page, 'Backups');
  await settings.getByRole('button', { name: 'Wipe All Data', exact: true }).click();
  await expect(page.getByText(/delete ALL lists, tasks, subtasks, mindmaps and the Shared Folder/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
});

test('the exported backup carries the Shared Folder links', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://example.com/keep-me');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText('example.com').first()).toBeVisible();

  const settings = await openSettingsTab(page, 'Backups');
  await settings.getByRole('button', { name: 'Export Backup', exact: true }).click();
  const exportDialog = dialogTitled(page, 'Export backup');
  await exportDialog.getByText('Unencrypted', { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const zip = await JSZip.loadAsync(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c)));
  const payload = JSON.parse(await zip.file('data.json')!.async('string'));
  expect(payload.sharedLinks.map((l: { url: string }) => l.url)).toEqual(['https://example.com/keep-me']);
});
