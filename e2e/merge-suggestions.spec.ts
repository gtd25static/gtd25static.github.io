// The "Possible duplicates" banner on the production build: "Not duplicates"
// keeps a pair apart for good (it used to be a × that only hid it until the list
// was reopened, so the same pairs came back again and again), and Review merges.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createList, openApp, openList, taskCards } from './helpers';

/** createTask() finds the new card by its text, which can't tell "Comprar leche" from "comprar leche": count the cards instead. */
async function addTask(page: Page, title: string): Promise<void> {
  const before = await taskCards(page).count();
  await page.getByRole('button', { name: 'Add a task' }).click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByPlaceholder('Task title').press('Enter');
  await expect(taskCards(page)).toHaveCount(before + 1);
}

test('"Not duplicates" keeps a pair apart after a reload; a new look-alike is still suggested', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Errands');
  await addTask(page, 'Comprar leche');
  await addTask(page, 'comprar leche');

  const banner = page.getByText('Possible duplicates');
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss suggestion' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Not duplicates' }).click();
  await expect(banner).toHaveCount(0);

  await page.reload();
  await openList(page, 'Errands');
  await expect(taskCards(page)).toHaveCount(2);
  await expect(banner).toHaveCount(0);

  await addTask(page, 'Comprar leche!');
  await expect(banner).toBeVisible();
});

test('Review merges the pair into one task', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Errands');
  await addTask(page, 'Llamar al banco');
  await addTask(page, 'llamar al banco');

  await page.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Merge/ }).click();
  await expect(taskCards(page)).toHaveCount(1);
  await expect(page.getByText('Possible duplicates')).toHaveCount(0);
});
